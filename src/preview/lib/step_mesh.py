#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STEP → S3DM 三角网格 + 边线框（单位 mm），供 DSH 3D 预览插件的 Host 半边调用。

独立实现：只依赖 OCP（OCCT 的 python 绑定）与 numpy（可选加速），
不 import、不修改 sw-mcp 仓库里的任何文件；思路与其 worker.py 一致但代码是独立写的。

用法：
    python step_mesh.py --in <step> --out <s3dm> --deflection 0.08 [--crease-angle 35]
                        [--angular-deflection 0.12] [--source-path <原始路径>]

退出码：
    0  成功（stdout 一行 JSON 摘要）
    2  参数错误
    3  OCP 不可用
    4  STEP 读取或三角化失败
    5  S3DM 写盘失败

输出约定：
    - stdout 最后一行 JSON 是给 Node 解析的摘要/错误体，其它行都不以 '{' 开头。
    - stderr 是人看的诊断（Node 侧只回传尾部 800 字符）。

法线约定（v2 起）：
    - 顶点按「写入 buffer 的精度」焊接（位置键 = rnd(coord, 5) 后的三元组），
      多面共享同一个顶点索引；顶点法线由它参与的所有三角形面法线按**折痕角阈值**平均：
      与某三角形法线夹角 <= CREASE_ANGLE_DEG 的邻面参与平均，> 阈值的不参与。
      于是圆柱/球面/圆孔变光滑，方块的棱和倒角的边仍然锐利。
    - 法线平均用**面积加权**：mesh 是曲面离散，三角形面积即该处曲面面积的采样，
      面积加权才能逼近真实曲面的法线（等权重会被小三角形拉偏，在曲率突变处产生可见条纹）。
"""

import argparse
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
import traceback

MAX_TRIANGLES = 300000      # 三角形上限默认值（可用 --max-triangles 覆盖）：超过先加大挠度重试一次，仍超则截断
                            # 实测新精度（0.08mm/0.12rad）下 6 个真实零件只有 2004~3500 个三角形，
                            # 离这里 90 倍余量，重试分支实际不会触发；故不下调也不上调，保持
                            # 与 lib/resolve.js 的 DEFAULT_MAX_TRIANGLES、客户端 mid 档一致。
MAX_EDGE_POINTS = 400000    # 边折线总点数上限：超过整体步长降采样
DEFAULT_DEFLECTION = 0.08   # mm：弦高误差。0.2 时 φ50 圆的侧壁只用 13 段，轮廓明显有棱
ANGULAR_DEFLECTION = 0.12   # 弧度（≈6.9°）：φ50 圆切成约 52 段；0.5 弧度只有约 13 段
CREASE_ANGLE_DEG = 35.0     # 折痕角阈值：相邻三角形法线夹角 <= 它才平滑平均，> 它保留锐边

S3DM_VERSION = 2            # v2：新增可选 faceEdge buffer + faceEdgeCount/maxTriangles 头字段

OCP_ERROR = None
try:
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.Bnd import Bnd_Box
    from OCP.GCPnts import GCPnts_QuasiUniformAbscissa
    from OCP.GeomAbs import (
        GeomAbs_Circle,
        GeomAbs_Cone,
        GeomAbs_Cylinder,
        GeomAbs_Line,
        GeomAbs_Plane,
        GeomAbs_Sphere,
        GeomAbs_Torus,
    )
    from OCP.GProp import GProp_GProps
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    HAVE_OCP = True
except Exception as error:  # pragma: no cover - 只在缺依赖时走到
    HAVE_OCP = False
    OCP_ERROR = "%s: %s" % (type(error).__name__, error)

try:
    import numpy as _np
except Exception:  # pragma: no cover - numpy 只是加速手段
    _np = None


class MeshError(RuntimeError):
    def __init__(self, code, message, exit_code=4):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


# --------------------------------------------------------------------------- 小工具

def rnd(value, digits=6):
    try:
        number = float(value)
    except Exception:
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(number, digits)


def align4(value):
    return (int(value) + 3) & ~3


def pack_f32(values):
    if _np is not None:
        return _np.asarray(values, dtype="<f4").tobytes()
    return struct.pack("<%df" % len(values), *values)


def pack_u32(values):
    if _np is not None:
        return _np.asarray(values, dtype="<u4").tobytes()
    return struct.pack("<%dI" % len(values), *values)


def tail(message, limit=2000):
    text = str(message)
    return text if len(text) <= limit else text[-limit:]


# --------------------------------------------------------------------------- S3DM 写

def write_s3dm(out_path, header, buffers):
    """按 S3DM 约定写文件：魔数 + u32 头长度 + header JSON + 4 字节对齐的 buffer 数据区。

    buffers: [{'name','type','components','count','data'(bytes)}]
    先写 .tmp 再 os.replace，避免 Node 侧读到半个文件。
    """
    descriptors = []
    chunks = []
    cursor = 0
    for entry in buffers:
        data = entry["data"]
        descriptors.append({
            "name": entry["name"],
            "type": entry["type"],
            "components": int(entry["components"]),
            "count": int(entry["count"]),
            "offset": cursor,
        })
        chunks.append((cursor, data))
        cursor += len(data)
        cursor += (4 - cursor % 4) % 4

    final_header = dict(header)
    final_header["buffers"] = descriptors
    json_bytes = json.dumps(final_header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # 客户端 parseS3DM 用 base = 8 + headerJsonLength 当数据区起点（不做 align4），
    # 并要求每个 buffer 绝对偏移 % 4 == 0。用空格把 JSON 补到 4 字节对齐，两边算法就重合。
    padding = (4 - ((8 + len(json_bytes)) % 4)) % 4
    if padding:
        json_bytes += b" " * padding
    section_start = 8 + len(json_bytes)
    out = bytearray(section_start + cursor)
    out[0:4] = b"S3DM"
    struct.pack_into("<I", out, 4, len(json_bytes))
    out[8:8 + len(json_bytes)] = json_bytes
    for offset, data in chunks:
        start = section_start + offset
        out[start:start + len(data)] = data

    temporary = out_path + ".tmp"
    with open(temporary, "wb") as handle:
        handle.write(out)
    os.replace(temporary, out_path)
    return len(out)


# --------------------------------------------------------------------------- OCCT 适配

def shape_map_types():
    """OCP 8 把模板实例放在 OCP.collections，OCP 7 放在 OCP.TopTools。"""
    try:
        from OCP.collections import (
            IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as edge_faces_map,
            IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as shape_map,
        )
        return shape_map, edge_faces_map
    except Exception:
        from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape
        return TopTools_IndexedMapOfShape, TopTools_IndexedDataMapOfShapeListOfShape


def use_mm_units():
    """STEP 可能按米/英寸声明长度单位；OCCT 靠 xstep.cascade.unit 换算到 mm。"""
    try:
        Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    except Exception:
        pass


def read_step(path):
    """读 STEP；直接打开失败时把文件复制成 ASCII 临时名再试一次（Windows 非 ASCII 路径兜底）。"""
    reader = STEPControl_Reader()
    status = reader.ReadFile(path)
    shape = None
    if status == IFSelect_RetDone:
        try:
            reader.TransferRoots()
            shape = reader.OneShape()
        except Exception:
            shape = None
        if shape is not None and not shape.IsNull():
            return shape

    temporary_dir = tempfile.mkdtemp(prefix="sw3d-step-")
    fallback = os.path.join(temporary_dir, "input.step")
    try:
        shutil.copyfile(path, fallback)
        reader = STEPControl_Reader()
        if reader.ReadFile(fallback) != IFSelect_RetDone:
            raise MeshError("STEP_READ_FAILED", "STEP 读取失败：%s" % path)
        reader.TransferRoots()
        shape = reader.OneShape()
        if shape is None or shape.IsNull():
            raise MeshError("STEP_EMPTY", "STEP 里没有可用的形体：%s" % path)
        return shape
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)


def shape_bbox(shape):
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    low, high = box.CornerMin(), box.CornerMax()
    bbox = [rnd(low.X()), rnd(low.Y()), rnd(low.Z()), rnd(high.X()), rnd(high.Y()), rnd(high.Z())]
    center = [(bbox[0] + bbox[3]) / 2.0, (bbox[1] + bbox[4]) / 2.0, (bbox[2] + bbox[5]) / 2.0]
    return bbox, center


def triangulate(shape, deflection, clean=False, angular_deflection=None):
    """就地三角化。clean=True 先丢掉已有网格 —— BRepMesh 是增量的，否则加大挠度没效果。

    angular_deflection 是**弧度**的弦高以外夹角上限：同一段圆弧要切成多少片由它决定。
    """
    if clean:
        try:
            BRepTools.Clean_s(shape, True)
        except Exception:
            pass
    angular = ANGULAR_DEFLECTION if angular_deflection is None else angular_deflection
    try:
        mesh = BRepMesh_IncrementalMesh(shape, deflection, False, angular, True)
        return bool(mesh.IsDone())
    except Exception:
        return False


def count_triangles(shape):
    total = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        location = TopLoc_Location()
        try:
            triangulation = BRep_Tool.Triangulation_s(face, location)
            if triangulation is not None:
                total += int(triangulation.NbTriangles())
        except Exception:
            pass
        explorer.Next()
    return total


FACE_KINDS = {
    int(GeomAbs_Plane): "plane",
    int(GeomAbs_Cylinder): "cylinder",
    int(GeomAbs_Cone): "cone",
    int(GeomAbs_Sphere): "sphere",
    int(GeomAbs_Torus): "torus",
}


def face_entry(index, face):
    """faces[] 的一条：类型 + 面积 + 可画标记的法向/点 + 半径（有就填）。"""
    area = 0.0
    props = GProp_GProps()
    try:
        BRepGProp.SurfaceProperties_s(face, props)
        area = float(props.Mass())
    except Exception:
        area = 0.0
    entry = {
        "index": index,
        "kind": "other",
        "areaMm2": rnd(area, 4),
        "normal": [0.0, 0.0, 0.0],
        "point": [0.0, 0.0, 0.0],
        "radiusMm": None,
    }
    try:
        adaptor = BRepAdaptor_Surface(face)
        kind = int(adaptor.GetType())
        entry["kind"] = FACE_KINDS.get(kind, "other")
        if kind == int(GeomAbs_Plane):
            plane = adaptor.Plane()
            direction = plane.Axis().Direction()
            origin = plane.Location()
            entry["normal"] = [rnd(direction.X()), rnd(direction.Y()), rnd(direction.Z())]
            entry["point"] = [rnd(origin.X()), rnd(origin.Y()), rnd(origin.Z())]
        elif kind == int(GeomAbs_Cylinder):
            cylinder = adaptor.Cylinder()
            axis = cylinder.Axis()
            entry["normal"] = [rnd(axis.Direction().X()), rnd(axis.Direction().Y()), rnd(axis.Direction().Z())]
            entry["point"] = [rnd(axis.Location().X()), rnd(axis.Location().Y()), rnd(axis.Location().Z())]
            entry["radiusMm"] = rnd(cylinder.Radius())
        elif kind == int(GeomAbs_Cone):
            cone = adaptor.Cone()
            axis = cone.Axis()
            entry["normal"] = [rnd(axis.Direction().X()), rnd(axis.Direction().Y()), rnd(axis.Direction().Z())]
            entry["point"] = [rnd(axis.Location().X()), rnd(axis.Location().Y()), rnd(axis.Location().Z())]
            entry["radiusMm"] = rnd(cone.RefRadius())
        elif kind == int(GeomAbs_Sphere):
            sphere = adaptor.Sphere()
            center = sphere.Location()
            entry["point"] = [rnd(center.X()), rnd(center.Y()), rnd(center.Z())]
            entry["radiusMm"] = rnd(sphere.Radius())
        elif kind == int(GeomAbs_Torus):
            torus = adaptor.Torus()
            center = torus.Location()
            entry["point"] = [rnd(center.X()), rnd(center.Y()), rnd(center.Z())]
            entry["radiusMm"] = rnd(torus.MajorRadius())
    except Exception:
        pass
    return entry


def triangle_cross(points):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = points
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    return (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)


def edge_polyline(edge, curve, length, deflection):
    """沿边取折线：直线 2 点；曲线按长度决定 8~96 点，失败退回参数均匀采样。"""
    first, last = curve.FirstParameter(), curve.LastParameter()
    kind = int(curve.GetType())
    if kind == int(GeomAbs_Line):
        samples = 2
    elif kind == int(GeomAbs_Circle):
        samples = max(12, min(96, int(math.ceil(length / max(deflection * 1.5, 0.05)))))
    else:
        samples = max(8, min(96, int(math.ceil(length / max(deflection * 1.5, 0.05)))))
    samples = max(2, samples)

    points = []
    try:
        sampler = GCPnts_QuasiUniformAbscissa(curve, samples)
        if sampler.IsDone() and sampler.NbPoints() >= 2:
            for index in range(1, sampler.NbPoints() + 1):
                point = curve.Value(sampler.Parameter(index))
                points.append((point.X(), point.Y(), point.Z()))
    except Exception:
        points = []
    if len(points) < 2:
        points = []
        span = last - first
        if abs(span) < 1e-12:
            span = 1e-6
        for index in range(samples):
            point = curve.Value(first + span * index / float(max(samples - 1, 1)))
            points.append((point.X(), point.Y(), point.Z()))
    if len(points) < 2:
        point = curve.Value(first)
        points = [(point.X(), point.Y(), point.Z()), (point.X(), point.Y(), point.Z())]
    return points


def position_key(point):
    """焊接键：用**写入 buffer 的精度**（rnd(x, 5)）量化坐标。

    必须和真正写进 position buffer 的值走同一个量化：否则键看起来相同、
    buffer 里却是两个略不同的坐标，客户端那边仍然是两套顶点。
    """
    return (rnd(point[0], 5), rnd(point[1], 5), rnd(point[2], 5))


def weld_and_smooth(corners, tri_normals, tri_areas, crease_angle_deg):
    """按位置焊接顶点，并按折痕角阈值计算平滑顶点法线。

    corners:     [(keyA, keyB, keyC), ...] 每个三角形的三个**位置键**
    tri_normals: [(nx, ny, nz), ...]      每个三角形自己的单位面法线
    tri_areas:   [area, ...]              每个三角形面积（面积加权用）

    返回 (positions, normals, indices) 三个扁平列表，可直接进 S3DM buffer。
    顺序稳定：顶点按位置首次出现顺序发射，三角形严格按输入顺序发射
    （faceOfTriangle 因此天然与三角形一一对应）。

    折痕规则：一个顶点位置周围可能同时存在「侧面」和「端面」。把该位置参与的
    三角形按**面法线夹角 <= 阈值**贪心聚类（大面积优先做种子），每个簇发射一个
    顶点、法线 = 簇内按面积加权的面法线平均。于是同一位置的圆柱侧壁连成一个
    顶点（光滑），而端面和侧壁因为夹角 90° > 35° 天然落进两个簇 —— 棱保持锐利。
    """
    threshold = math.cos(math.radians(max(0.0, min(179.0, crease_angle_deg))))

    # 位置键 → 参与该位置的三角形列表（按面积降序，种子取最大的面，结果与输入顺序无关）
    at_position = {}
    order = []
    for triangle_index, keys in enumerate(corners):
        for key in keys:
            bucket = at_position.get(key)
            if bucket is None:
                bucket = []
                at_position[key] = bucket
                order.append(key)
            bucket.append(triangle_index)
    for key in order:
        at_position[key].sort(key=lambda t: (-tri_areas[t], t))

    # (位置键, 三角形) → (该位置的簇序号)，以及 (位置键, 簇序号) → 最终顶点索引。
    # 两张表分开：第一遍只做聚类，顶点索引等簇定下来再统一分配，避开「先写负号再解码」
    # 这类容易写错的自欺编码。
    cluster_of = {}
    vertex_of = {}
    vertex_keys = []
    vertex_normals = []
    for key in order:
        members = at_position[key]
        clusters = []       # [面积加权法线和（未归一化）]
        for triangle_index in members:
            normal = tri_normals[triangle_index]
            if normal is None:
                cluster_of[(key, triangle_index)] = None
                continue
            weight = tri_areas[triangle_index]
            placed = -1
            for cluster_index, total in enumerate(clusters):
                # 与簇内**当前平均方向**的夹角 <= 折痕角才算同一个平滑区域
                if _dot(total, normal) >= threshold * _length(total):
                    placed = cluster_index
                    break
            if placed < 0:
                placed = len(clusters)
                clusters.append([normal[0] * weight, normal[1] * weight, normal[2] * weight])
            else:
                total = clusters[placed]
                total[0] += normal[0] * weight
                total[1] += normal[1] * weight
                total[2] += normal[2] * weight
            cluster_of[(key, triangle_index)] = placed

        if not clusters:
            # 该位置参与的三角形全是退化面（叉积为零）：发射一个零法线顶点。
            vertex_of[(key, -1)] = len(vertex_keys)
            vertex_keys.append(key)
            vertex_normals.append((0.0, 0.0, 0.0))
            for triangle_index in members:
                cluster_of[(key, triangle_index)] = -1
            continue
        for cluster_index, total in enumerate(clusters):
            vertex_of[(key, cluster_index)] = len(vertex_keys)
            vertex_keys.append(key)
            vertex_normals.append(_unit(total))

    triangles = []
    for triangle_index, keys in enumerate(corners):
        emitted = []
        usable = True
        for key in keys:
            slot = cluster_of.get((key, triangle_index))
            index = None if slot is None else vertex_of.get((key, slot))
            if index is None:
                usable = False
                break
            emitted.append(index)
        if not usable:
            # 防御：三角形绝不能丢（faceOfTriangle 必须一一对应）。退化或缺失时
            # 退回「该三角形单独一套顶点 + 它自己的面法线」的保守路径。
            normal = _unit(tri_normals[triangle_index] or (0.0, 0.0, 0.0))
            emitted = []
            for key in keys:
                emitted.append(len(vertex_keys))
                vertex_keys.append(key)
                vertex_normals.append(normal)
        triangles.append((emitted[0], emitted[1], emitted[2]))

    positions = []
    for key in vertex_keys:
        positions.extend(key)
    flat_normals = []
    for normal in vertex_normals:
        flat_normals.extend((rnd(normal[0], 5), rnd(normal[1], 5), rnd(normal[2], 5)))
    flat_indices = []
    for emitted in triangles:
        flat_indices.extend(emitted)
    return positions, flat_normals, flat_indices


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _length(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def _unit(a):
    length = _length(a)
    if length <= 1e-12:
        return (0.0, 0.0, 0.0)
    return (a[0] / length, a[1] / length, a[2] / length)


# --------------------------------------------------------------------------- 主流程

def build_mesh(in_path, out_path, deflection, source_path=None, max_triangles=None,
               crease_angle=None, angular_deflection=None):
    started = time.time()
    if not HAVE_OCP:
        raise MeshError("OCP_MISSING", "缺少 OCP（OCCT python 绑定）：%s" % OCP_ERROR, 3)
    if not os.path.isfile(in_path):
        raise MeshError("NOT_FOUND", "STEP 文件不存在：%s" % in_path, 2)

    try:
        triangle_limit = int(max_triangles) if max_triangles else MAX_TRIANGLES
    except Exception:
        triangle_limit = MAX_TRIANGLES
    triangle_limit = max(2000, min(5000000, triangle_limit))

    try:
        crease_deg = float(crease_angle) if crease_angle is not None else CREASE_ANGLE_DEG
    except Exception:
        crease_deg = CREASE_ANGLE_DEG
    if not math.isfinite(crease_deg):
        crease_deg = CREASE_ANGLE_DEG
    # 0° = 等价于原来的平面着色（每个三角形一个顶点集合）；180° = 全平滑（会磨圆所有棱）。
    crease_deg = max(0.0, min(180.0, crease_deg))

    try:
        angular = float(angular_deflection) if angular_deflection else ANGULAR_DEFLECTION
    except Exception:
        angular = ANGULAR_DEFLECTION
    if not math.isfinite(angular) or angular <= 0.0:
        angular = ANGULAR_DEFLECTION
    angular = max(0.01, min(math.pi, angular))

    use_mm_units()
    shape = read_step(in_path)
    bbox, center = shape_bbox(shape)

    warnings = []
    truncated_triangles = False
    truncated_edges = False
    retried = False

    triangulate(shape, deflection, angular_deflection=angular)
    triangle_total = count_triangles(shape)
    effective_deflection = deflection
    effective_angular = angular
    if triangle_total > triangle_limit:
        # 细分同时受「弦高挠度」和「角向挠度」约束：圆柱这类曲面几乎完全由角向决定，
        # 所以重试必须**两个一起放大**，只放大弦高会一点效果都没有（实测 φ50 圆柱
        # 0.2mm/0.5rad=140 片、0.2mm/0.12rad=416 片，光调弦高压不下来）。
        scale = math.sqrt(triangle_total / float(triangle_limit)) * 1.05
        retry_deflection = min(50.0, deflection * scale)
        retry_angular = min(math.pi, angular * scale)
        if triangulate(shape, retry_deflection, clean=True, angular_deflection=retry_angular):
            retried_total = count_triangles(shape)
            if retried_total < triangle_total:
                effective_deflection = retry_deflection
                effective_angular = retry_angular
                triangle_total = retried_total
                retried = True
                warnings.append(
                    "三角形数 %d 超过上限 %d，挠度 %.4f→%.4f mm、角向 %.4f→%.4f rad 后重算"
                    % (triangle_total, triangle_limit, deflection, effective_deflection,
                       angular, effective_angular)
                )

    ShapeMap, EdgeFacesMap = shape_map_types()
    face_map = ShapeMap()
    edge_map = ShapeMap()
    TopExp.MapShapes_s(shape, TopAbs_FACE, face_map)
    TopExp.MapShapes_s(shape, TopAbs_EDGE, edge_map)
    edge_faces = EdgeFacesMap()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, edge_faces)

    # 先收集三角形（位置键 + 面法线 + 面积），再统一焊接 + 平滑法线。
    # 直接按三角形展平写顶点是「顶点不共享 + 面法线」= 纯平面着色，曲面会有明显面片感。
    corners = []                 # [(keyA, keyB, keyC)]
    triangle_normals = []        # 每个三角形自己的单位面法线
    triangle_areas = []          # 每个三角形的面积（面积加权）
    face_of_triangle = []
    faces = []
    flip_votes = 0.0

    face_count = face_map.Extent()
    for face_index in range(face_count):
        face = TopoDS.Face(face_map.FindKey(face_index + 1))
        entry = face_entry(face_index, face)
        location = TopLoc_Location()
        triangulation = None
        try:
            triangulation = BRep_Tool.Triangulation_s(face, location)
        except Exception:
            triangulation = None
        if triangulation is None:
            faces.append(entry)
            continue

        try:
            node_count = int(triangulation.NbNodes())
            triangle_count = int(triangulation.NbTriangles())
        except Exception:
            node_count, triangle_count = 0, 0
        if node_count <= 0 or triangle_count <= 0:
            faces.append(entry)
            continue
        if len(face_of_triangle) >= triangle_limit:
            truncated_triangles = True
            faces.append(entry)
            continue

        transform = None if location.IsIdentity() else location.Transformation()
        nodes = []
        for node_index in range(1, node_count + 1):
            point = triangulation.Node(node_index)
            if transform is not None:
                point = point.Transformed(transform)
            nodes.append((point.X(), point.Y(), point.Z()))
        reversed_face = face.Orientation() == TopAbs_REVERSED

        accumulated = [0.0, 0.0, 0.0]
        local_area = 0.0
        for triangle_index in range(1, triangle_count + 1):
            if len(face_of_triangle) >= triangle_limit:
                truncated_triangles = True
                break
            try:
                ia, ib, ic = triangulation.Triangle(triangle_index).Get()
            except Exception:
                continue
            points = [nodes[ia - 1], nodes[ib - 1], nodes[ic - 1]]
            if reversed_face:
                points = [points[0], points[2], points[1]]
            cross = triangle_cross(points)
            length = math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2)
            area = length / 2.0
            if length > 1e-12:
                unit = (cross[0] / length, cross[1] / length, cross[2] / length)
            else:
                unit = None
            accumulated[0] += cross[0]
            accumulated[1] += cross[1]
            accumulated[2] += cross[2]
            local_area += area
            corners.append(tuple(position_key(point) for point in points))
            triangle_normals.append(unit)
            triangle_areas.append(area)
            face_of_triangle.append(face_index)

        magnitude = math.sqrt(accumulated[0] ** 2 + accumulated[1] ** 2 + accumulated[2] ** 2)
        if magnitude > 0.0:
            entry["normal"] = [
                rnd(accumulated[0] / magnitude, 6),
                rnd(accumulated[1] / magnitude, 6),
                rnd(accumulated[2] / magnitude, 6),
            ]
        if local_area > 0.0:
            centroid = [0.0, 0.0, 0.0]
            for point in nodes:
                centroid[0] += point[0]
                centroid[1] += point[1]
                centroid[2] += point[2]
            count = len(nodes)
            centroid = [centroid[0] / count, centroid[1] / count, centroid[2] / count]
            flip_votes += local_area * (
                (centroid[0] - center[0]) * entry["normal"][0]
                + (centroid[1] - center[1]) * entry["normal"][1]
                + (centroid[2] - center[2]) * entry["normal"][2]
            )
        faces.append(entry)

    # 焊接顶点 + 按折痕角平滑法线（面积加权平均）
    vertices_before = len(corners) * 3
    positions, normals, indices = weld_and_smooth(
        corners, triangle_normals, triangle_areas, crease_deg
    )

    # 整块实体的朝向自检：面积加权点积为负说明所有面都朝内，统一翻面。
    # 焊接后每个顶点只有一条法线，取反仍然正确；顶点索引不变，只换 winding。
    if flip_votes < 0.0:
        warnings.append("面法向整体朝内（面积加权点积为负），已统一翻转")
        for index in range(0, len(normals), 3):
            normals[index] = -normals[index]
            normals[index + 1] = -normals[index + 1]
            normals[index + 2] = -normals[index + 2]
        for index in range(0, len(indices), 3):
            indices[index + 1], indices[index + 2] = indices[index + 2], indices[index + 1]
        for entry in faces:
            entry["normal"] = [-value for value in entry["normal"]]

    # ------------------------------------------------------------------ 边线框
    edge_positions = []
    edge_segments = []
    edges = []
    edge_count = edge_map.Extent()
    for edge_index in range(edge_count):
        edge = TopoDS.Edge(edge_map.FindKey(edge_index + 1))
        if edge.IsNull():
            continue
        try:
            if BRep_Tool.Degenerated_s(edge):
                continue
        except Exception:
            pass
        try:
            curve = BRepAdaptor_Curve(edge)
        except Exception:
            continue
        length = 0.0
        try:
            properties = GProp_GProps()
            BRepGProp.LinearProperties_s(edge, properties)
            length = float(properties.Mass())
        except Exception:
            length = 0.0
        try:
            points = edge_polyline(edge, curve, length, effective_deflection)
        except Exception:
            continue
        if len(points) < 2:
            continue
        start_index = len(edge_positions) // 3
        for point in points:
            edge_positions.extend((rnd(point[0], 5), rnd(point[1], 5), rnd(point[2], 5)))
        for offset in range(len(points) - 1):
            edge_segments.extend((start_index + offset, start_index + offset + 1))

        is_circle = False
        radius = None
        try:
            is_circle = int(curve.GetType()) == int(GeomAbs_Circle)
            if is_circle:
                radius = rnd(curve.Circle().Radius())
        except Exception:
            is_circle, radius = False, None

        adjacent = []
        try:
            for ancestor in edge_faces.FindFromKey(edge):
                face_index = int(face_map.FindIndex(ancestor)) - 1
                if face_index >= 0 and face_index not in adjacent:
                    adjacent.append(face_index)
        except Exception:
            adjacent = []

        middle = points[len(points) // 2]
        edges.append({
            "index": len(edges),
            "isCircle": bool(is_circle),
            "radiusMm": radius,
            "lengthMm": rnd(length),
            "start": [rnd(points[0][0], 5), rnd(points[0][1], 5), rnd(points[0][2], 5)],
            "end": [rnd(points[-1][0], 5), rnd(points[-1][1], 5), rnd(points[-1][2], 5)],
            "mid": [rnd(middle[0], 5), rnd(middle[1], 5), rnd(middle[2], 5)],
            "faces": adjacent[:2],
            "polylineStart": start_index,
            "polylineCount": len(points),
        })

    # ------------------------------------------------------------------ 面↔边 关联（S3DM v2 可选 buffer）
    # [faceIndex, edgeIndex] 成对展开；客户端拿不到这个 buffer 时可以从 edges[].faces 反推，所以是可选字段。
    face_edge = []
    for entry in edges:
        for face_index in entry["faces"]:
            if isinstance(face_index, int) and 0 <= face_index < len(faces):
                face_edge.extend((face_index, entry["index"]))

    total_edge_points = len(edge_positions) // 3
    if total_edge_points > MAX_EDGE_POINTS:
        truncated_edges = True
        stride = int(math.ceil(total_edge_points / float(MAX_EDGE_POINTS)))
        new_positions = []
        new_segments = []
        for entry in edges:
            start = entry["polylineStart"]
            count = entry["polylineCount"]
            points = []
            for offset in range(0, count):
                if offset % stride == 0 or offset == count - 1:
                    points.append((start + offset) * 3)
            if len(points) < 2:
                points = [start * 3, (start + count - 1) * 3]
            new_start = len(new_positions) // 3
            for flat_index in points:
                new_positions.extend(edge_positions[flat_index:flat_index + 3])
            for offset in range(len(points) - 1):
                new_segments.extend((new_start + offset, new_start + offset + 1))
            entry["polylineStart"] = new_start
            entry["polylineCount"] = len(points)
            entry["mid"] = [
                rnd(new_positions[(new_start + len(points) // 2) * 3], 5),
                rnd(new_positions[(new_start + len(points) // 2) * 3 + 1], 5),
                rnd(new_positions[(new_start + len(points) // 2) * 3 + 2], 5),
            ]
        edge_positions = new_positions
        edge_segments = new_segments
        warnings.append("边折线总点数超上限 %d，按步长 %d 降采样" % (MAX_EDGE_POINTS, stride))

    # ------------------------------------------------------------------ 单位自检
    sizes = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
    if max(sizes) > 20000.0:
        warnings.append("包围盒最大边 %.1f mm，疑似 STEP 单位不是 mm（可能是米制误读）" % max(sizes))
    if 0.0 < max(sizes) < 0.5:
        warnings.append("包围盒最大边只有 %.3f mm，疑似 STEP 单位不是 mm（可能被当成米）" % max(sizes))
    if len(indices) == 0:
        warnings.append("三角化没有产出三角形：形体可能只有线框/曲面但无实体")

    vertex_count = len(positions) // 3
    triangle_count = len(indices) // 3
    source_bytes = 0
    source_mtime = 0
    try:
        source_stat = os.stat(source_path or in_path)
        source_bytes = int(source_stat.st_size)
        source_mtime = int(round(source_stat.st_mtime * 1000))
    except Exception:
        pass

    header = {
        "version": S3DM_VERSION,
        "units": "mm",
        "format": "step",
        "source": {
            "path": source_path or in_path,
            "bytes": source_bytes,
            "mtimeMs": source_mtime,
        },
        "bbox": bbox,
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "faceCount": len(faces),
        "edgeCount": len(edges),
        "faceEdgeCount": len(face_edge) // 2,
        "faces": faces,
        "edges": edges,
        "warnings": warnings,
        "deflectionMm": rnd(effective_deflection, 4),
        "angularDeflectionRad": rnd(effective_angular, 5),
        "maxTriangles": triangle_limit,
        "creaseAngleDeg": rnd(crease_deg, 2),
        "welded": {
            "verticesBefore": vertices_before,
            "verticesAfter": vertex_count,
            "ratio": rnd(vertex_count / float(vertices_before), 4) if vertices_before else 0.0,
        },
        "precision": {
            "deflectionMm": rnd(effective_deflection, 4),
            "maxTriangles": triangle_limit,
        },
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "retried": retried,
    }
    buffers = [
        {"name": "position", "type": "f32", "components": 3, "count": vertex_count, "data": pack_f32(positions)},
        {"name": "normal", "type": "f32", "components": 3, "count": vertex_count, "data": pack_f32(normals)},
        {"name": "index", "type": "u32", "components": 3, "count": triangle_count, "data": pack_u32(indices)},
        {
            "name": "faceOfTriangle",
            "type": "u32",
            "components": 1,
            "count": triangle_count,
            "data": pack_u32(face_of_triangle),
        },
        {
            "name": "edgePosition",
            "type": "f32",
            "components": 3,
            "count": len(edge_positions) // 3,
            "data": pack_f32(edge_positions),
        },
        {
            "name": "edgeSegment",
            "type": "u32",
            "components": 2,
            "count": len(edge_segments) // 2,
            "data": pack_u32(edge_segments),
        },
        {
            "name": "faceEdge",
            "type": "u32",
            "components": 2,
            "count": len(face_edge) // 2,
            "data": pack_u32(face_edge),
        },
    ]
    written = write_s3dm(out_path, header, buffers)

    elapsed = time.time() - started
    if truncated_triangles:
        warnings.append("三角形数已达上限 %d，多余部分被截断" % triangle_limit)
    return {
        "ok": True,
        "path": source_path or in_path,
        "out": out_path,
        "bytes": written,
        "seconds": round(elapsed, 3),
        "bbox": bbox,
        "sizeMm": [rnd(value, 4) for value in sizes],
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "faceCount": len(faces),
        "edgeCount": len(edges),
        "faceEdgeCount": len(face_edge) // 2,
        "edgePointCount": len(edge_positions) // 3,
        "truncated": {"triangles": truncated_triangles, "edges": truncated_edges},
        "deflectionMm": rnd(effective_deflection, 4),
        "angularDeflectionRad": rnd(effective_angular, 5),
        "creaseAngleDeg": rnd(crease_deg, 2),
        "welded": {
            "verticesBefore": vertices_before,
            "verticesAfter": vertex_count,
            "ratio": rnd(vertex_count / float(vertices_before), 4) if vertices_before else 0.0,
        },
        "maxTriangles": triangle_limit,
        "retried": retried,
        "warnings": warnings,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="STEP → S3DM（mm）")
    parser.add_argument("--in", dest="input", required=True, help="输入 STEP 路径")
    parser.add_argument("--out", dest="output", required=True, help="输出 S3DM 路径")
    parser.add_argument("--deflection", dest="deflection", type=float, default=DEFAULT_DEFLECTION)
    parser.add_argument("--max-triangles", dest="max_triangles", type=int, default=MAX_TRIANGLES,
                        help="三角形上限（精度档）；超出会先同时加大弦高/角向挠度重算，仍超则截断")
    parser.add_argument("--crease-angle", dest="crease_angle", type=float, default=CREASE_ANGLE_DEG,
                        help="折痕角阈值（度）：相邻面法线夹角 <= 它才平滑平均；0=纯平面着色，180=全平滑")
    parser.add_argument("--angular-deflection", dest="angular_deflection", type=float, default=ANGULAR_DEFLECTION,
                        help="角向挠度（弧度），越小圆弧切得越细")
    parser.add_argument("--source-path", dest="source_path", default=None, help="写进 header.source.path 的原始路径")
    args = parser.parse_args(argv)

    deflection = args.deflection if args.deflection and args.deflection > 0 else DEFAULT_DEFLECTION
    try:
        summary = build_mesh(args.input, args.output, deflection, args.source_path, args.max_triangles,
                             args.crease_angle, args.angular_deflection)
    except MeshError as error:
        print(str(error), file=sys.stderr)
        print(json.dumps({"ok": False, "code": error.code, "message": str(error)}, ensure_ascii=False), flush=True)
        return error.exit_code
    except Exception as error:
        traceback.print_exc()
        print(json.dumps({"ok": False, "code": "STEP_MESH_FAILED", "message": tail(error)}, ensure_ascii=False), flush=True)
        return 4
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    # Windows 下 pipe 的 stdout 默认是 GBK（cp936），Node 侧按 UTF-8 读，必须显式改写。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())
