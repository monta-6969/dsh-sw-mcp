"""sw-mcp 几何/图像分析 worker（常驻，JSONL over stdio）。

设计约束：
- 只做只读分析，不碰 SOLIDWORKS；输入是本机文件路径。
- 启动一次，后续请求复用进程；OCP 的 import 只在健康检查时暴露。
- 所有输出可 JSON 序列化；点坐标保留 4 位小数。
- step.mesh 是唯一返回大数组的 op：三角形必须带 B-rep 面索引、边必须带折线，
  供预览端画线框与点选面；因此它单独做截断与上限保护（见 op_step_mesh）。

用法：python worker.py；每行一个请求 {"id":"1","op":"health"}。
"""
import json
import math
import os
import sys
import traceback

try:
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.Bnd import Bnd_Box
    from OCP.GCPnts import GCPnts_QuasiUniformAbscissa
    from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus
    from OCP.GProp import GProp_GProps
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_VERTEX, TopAbs_WIRE
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pln, gp_Pnt
    from OCP.TopoDS import TopoDS
    HAVE_OCP = True
    OCP_ERROR = None
except Exception as error:  # pragma: no cover - 诊断用
    HAVE_OCP = False
    OCP_ERROR = f"{type(error).__name__}: {error}"

try:
    from PIL import Image
    HAVE_PIL = True
except Exception as error:  # pragma: no cover
    HAVE_PIL = False
    PIL_ERROR = f"{type(error).__name__}: {error}"


def rnd(value, digits=4):
    try:
        return round(float(value), digits)
    except Exception:
        return None


def read_step(path):
    reader = STEPControl_Reader()
    status = reader.ReadFile(path)
    if status != IFSelect_RetDone:
        raise RuntimeError(f"STEP read failed (status {status})")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        raise RuntimeError("STEP contains no shape")
    return shape


def shape_props(shape):
    volume = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, volume)
    surface = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, surface)
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    lo, hi = box.CornerMin(), box.CornerMax()
    xmin, ymin, zmin = lo.X(), lo.Y(), lo.Z()
    xmax, ymax, zmax = hi.X(), hi.Y(), hi.Z()
    return {
        "volumeMm3": rnd(volume.Mass(), 6),
        "areaMm2": rnd(surface.Mass(), 6),
        "bbox": {"min": [rnd(xmin), rnd(ymin), rnd(zmin)], "max": [rnd(xmax), rnd(ymax), rnd(zmax)]},
        "centerMm": [rnd((xmin + xmax) / 2), rnd((ymin + ymax) / 2), rnd((zmin + zmax) / 2)],
        "sizeMm": [rnd(xmax - xmin), rnd(ymax - ymin), rnd(zmax - zmin)],
    }


def count(shape, kind):
    exp = TopExp_Explorer(shape, kind)
    total = 0
    while exp.More():
        total += 1
        exp.Next()
    return total


def sample_edge(edge, deflection=0.2):
    curve = BRepAdaptor_Curve(edge)
    first, last = curve.FirstParameter(), curve.LastParameter()
    length = curve.Value(last).Distance(curve.Value(first))
    samples = max(2, min(96, int(math.ceil(length / max(deflection, 0.05)))))
    sampler = GCPnts_QuasiUniformAbscissa(curve, samples)
    points = []
    if sampler.IsDone():
        for index in range(1, sampler.NbPoints() + 1):
            pnt = curve.Value(sampler.Parameter(index))
            points.append([rnd(pnt.X()), rnd(pnt.Y()), rnd(pnt.Z())])
    if not points:
        for index in range(samples):
            pnt = curve.Value(first + (last - first) * index / max(samples - 1, 1))
            points.append([rnd(pnt.X()), rnd(pnt.Y()), rnd(pnt.Z())])
    return points


def edges_of(compound, deflection=0.2):
    if compound is None or compound.IsNull():
        return []
    exp = TopExp_Explorer(compound, TopAbs_EDGE)
    result = []
    while exp.More():
        points = sample_edge(TopoDS.Edge(exp.Current()), deflection)
        if len(points) >= 2:
            length = sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
            result.append({"points": points, "length": rnd(length), "closed": math.dist(points[0], points[-1]) <= 1e-3})
        exp.Next()
    return result


def plane_basis(normal, up_hint=None):
    nx, ny, nz = normal
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    normal = (nx / length, ny / length, nz / length)
    hint = up_hint or (0.0, 0.0, 1.0)
    if abs(sum(normal[i] * hint[i] for i in range(3))) > 0.98:
        hint = (0.0, 1.0, 0.0)
    ux = (normal[1] * hint[2] - normal[2] * hint[1],
          normal[2] * hint[0] - normal[0] * hint[2],
          normal[0] * hint[1] - normal[1] * hint[0])
    ul = math.sqrt(sum(value * value for value in ux)) or 1.0
    u = tuple(value / ul for value in ux)
    v = (normal[1] * u[2] - normal[2] * u[1],
         normal[2] * u[0] - normal[0] * u[2],
         normal[0] * u[1] - normal[1] * u[0])
    return normal, u, v


def to_plane(points, origin, u, v):
    ox, oy, oz = origin
    out = []
    for x, y, z in points:
        dx, dy, dz = x - ox, y - oy, z - oz
        out.append([rnd(dx * u[0] + dy * u[1] + dz * u[2]), rnd(dx * v[0] + dy * v[1] + dz * v[2])])
    return out


def polygon_area(points):
    total = 0.0
    for index in range(len(points) - 1):
        x1, y1 = points[index]
        x2, y2 = points[index + 1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def op_health(params):
    return {
        "python": sys.version.split()[0],
        "ocp": HAVE_OCP,
        "ocpError": OCP_ERROR,
        "pillow": HAVE_PIL,
        "pillowError": None if HAVE_PIL else PIL_ERROR,
        "cwd": os.getcwd(),
    }


def op_step_info(params):
    shape = read_step(params["path"])
    result = {"path": params["path"], "faces": count(shape, TopAbs_FACE), "edges": count(shape, TopAbs_EDGE)}
    result.update(shape_props(shape))
    return result


def op_step_hlr(params):
    shape = read_step(params["path"])
    view = params.get("viewDir") or [0, 0, 1]
    up = params.get("upDir") or [0, 1, 0]
    normal, u, v = plane_basis(view, up)
    origin = params.get("origin") or [0, 0, 0]
    projector = HLRAlgo_Projector(gp_Ax2(gp_Pnt(*origin), gp_Dir(*normal), gp_Dir(*u)))
    algo = HLRBRep_Algo()
    algo.Add(shape)
    algo.Projector(projector)
    algo.Update()
    algo.Hide()
    hlr = HLRBRep_HLRToShape(algo)

    def projected(edges):
        out = []
        for edge in edges:
            flat = [[point[0], point[1]] for point in edge["points"]]
            out.append({"points": flat, "length": rnd(edge["length"]), "closed": edge["closed"]})
        return out

    visible = edges_of(hlr.VCompound(), params.get("deflection", 0.2))
    outline = edges_of(hlr.OutLineVCompound(), params.get("deflection", 0.2))
    hidden = edges_of(hlr.HCompound(), params.get("deflection", 0.2)) if params.get("hidden", True) else []
    return {
        "viewDir": normal,
        "upDir": u,
        "visible": projected(visible),
        "outline": projected(outline),
        "hidden": projected(hidden),
        "visibleEdges": len(visible) + len(outline),
        "hiddenEdges": len(hidden),
    }


def op_step_section(params):
    shape = read_step(params["path"])
    origin = params.get("origin") or [0, 0, 0]
    normal = params.get("normal") or [0, 0, 1]
    normal, u, v = plane_basis(normal)
    section = BRepAlgoAPI_Section(shape, gp_Pln(gp_Pnt(*origin), gp_Dir(*normal)))
    section.Build()
    if not section.IsDone():
        raise RuntimeError("section failed")
    loops = []
    exp = TopExp_Explorer(section.Shape(), TopAbs_EDGE)
    while exp.More():
        points = sample_edge(TopoDS.Edge(exp.Current()), params.get("deflection", 0.2))
        flat = to_plane(points, origin, u, v)
        if len(flat) >= 2:
            loops.append({"points": flat, "length": rnd(sum(math.dist(flat[i], flat[i + 1]) for i in range(len(flat) - 1))),
                          "closed": math.dist(flat[0], flat[-1]) <= 1e-3})
        exp.Next()
    area = 0.0
    for loop in loops:
        if loop["closed"] and len(loop["points"]) >= 3:
            area += polygon_area(loop["points"])
    return {
        "origin": origin, "normal": normal, "u": u, "v": v,
        "loops": loops, "totalLength": rnd(sum(loop["length"] for loop in loops)), "areaMm2": rnd(area, 6),
    }


def surface_info(face):
    adaptor = BRepAdaptor_Surface(face)
    kind = adaptor.GetType()
    info = {"surfaceType": {GeomAbs_Plane: "plane", GeomAbs_Cylinder: "cylinder", GeomAbs_Cone: "cone",
                            GeomAbs_Sphere: "sphere", GeomAbs_Torus: "torus"}.get(kind, "other"), "typeCode": int(kind)}
    if kind == GeomAbs_Plane:
        plane = adaptor.Plane()
        direction = plane.Axis().Direction()
        location = plane.Location()
        info["normal"] = [rnd(direction.X()), rnd(direction.Y()), rnd(direction.Z())]
        info["point"] = [rnd(location.X()), rnd(location.Y()), rnd(location.Z())]
    elif kind == GeomAbs_Cylinder:
        cylinder = adaptor.Cylinder()
        direction = cylinder.Axis().Direction()
        location = cylinder.Axis().Location()
        info["axis"] = [rnd(direction.X()), rnd(direction.Y()), rnd(direction.Z())]
        info["point"] = [rnd(location.X()), rnd(location.Y()), rnd(location.Z())]
        info["radiusMm"] = rnd(cylinder.Radius())
    elif kind == GeomAbs_Cone:
        cone = adaptor.Cone()
        info["radiusMm"] = rnd(cone.RefRadius())
        info["halfAngleDeg"] = rnd(cone.SemiAngle() * 180.0 / math.pi)
    elif kind == GeomAbs_Sphere:
        info["radiusMm"] = rnd(adaptor.Sphere().Radius())
    elif kind == GeomAbs_Torus:
        info["majorRadiusMm"] = rnd(adaptor.Torus().MajorRadius())
        info["minorRadiusMm"] = rnd(adaptor.Torus().MinorRadius())
    return info


def op_step_faces(params):
    shape = read_step(params["path"])
    limit = int(params.get("maxFaces", 400))
    faces = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    index = 0
    while exp.More() and index < limit:
        face = TopoDS.Face(exp.Current())
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        wires = 0
        wexp = TopExp_Explorer(face, TopAbs_WIRE)
        while wexp.More():
            wires += 1
            wexp.Next()
        entry = {"index": index, "areaMm2": rnd(props.Mass(), 4), "wires": wires, "hasInnerLoops": wires > 1}
        entry.update(surface_info(face))
        faces.append(entry)
        index += 1
        exp.Next()
    return {"path": params["path"], "faces": faces, "truncated": index >= limit}


def op_step_diff(params):
    """两份 STEP 的形体差异，按可复核的区域给出预期/实测与下一次观察建议。

    这不是像素 diff：体积、包围盒、面/边数是 B-rep 的一等事实，能直接
    回答「材料少了还是多了、外形尺寸哪一轴变了」。更细的面级差异需要
    稳定 faceId，当前先给区域与实体类型，避免给出看似精确、实则对不上的编号。
    """
    first, second = params["a"], params["b"]
    shape_a, shape_b = read_step(first), read_step(second)
    info_a, info_b = shape_props(shape_a), shape_props(shape_b)
    faces_a, faces_b = count(shape_a, TopAbs_FACE), count(shape_b, TopAbs_FACE)
    edges_a, edges_b = count(shape_a, TopAbs_EDGE), count(shape_b, TopAbs_EDGE)
    tol_v = float(params.get("volumeToleranceMm3", max(1.0, abs(info_a["volumeMm3"]) * 1e-4)))
    tol_l = float(params.get("lengthToleranceMm", 0.01))
    items = []

    def add(region, expected, measured, delta, tolerance, suggestion, unit):
        if abs(delta) <= tolerance:
            return
        items.append({
            "region": region,
            "expected": expected,
            "measured": measured,
            "delta": rnd(delta, 6),
            "unit": unit,
            "entityRef": f"brep:{region}",
            "nextObservation": suggestion,
        })

    add("体积", info_a["volumeMm3"], info_b["volumeMm3"],
        info_b["volumeMm3"] - info_a["volumeMm3"], tol_v,
        "沿变化最大的轴做剖视（analysis action=section），确认是材料增减还是孔/腔位置变化", "mm3")
    for axis, index in (("X", 0), ("Y", 1), ("Z", 2)):
        add(f"包围盒.{axis}", info_a["sizeMm"][index], info_b["sizeMm"][index],
            info_b["sizeMm"][index] - info_a["sizeMm"][index], tol_l,
            "在正对该轴的视图做消隐投影（analysis action=hlr），比较外轮廓与台阶位置", "mm")
    add("面数", faces_a, faces_b, faces_b - faces_a, 0,
        "按面类型清点（analysis action=faces）：圆柱面增加通常意味着多了孔/凸台", "count")
    add("边数", edges_a, edges_b, edges_b - edges_a, 0,
        "检查隐藏线：边数变化常来自圆角、倒角或相贯线", "count")
    return {
        "a": {"path": first, **info_a, "faces": faces_a, "edges": edges_a},
        "b": {"path": second, **info_b, "faces": faces_b, "edges": edges_b},
        "items": items,
        "equal": len(items) == 0,
        "tolerances": {"volumeMm3": tol_v, "lengthMm": tol_l},
    }


# --------------------------------------------------------------------------- 网格/线框
#
# step.mesh 是唯一返回大数组的 op，给 3D 预览画三角面与边线框。硬约束：
#   1) 每个三角形都能追溯回 B-rep 面 —— triangles[] 第 4 个分量就是 faces[] 下标；
#   2) 每条边都带折线 —— 预览画线框/量长度都靠它；
#   3) 法向不能被 face.Orientation() 搞反 —— 用「包围盒中心→面重心」与面法向的
#      面积加权点积自检，为负就整块翻转。
# 大模型保护：三角形数超上限时先加大 deflection 重试一次，仍超才截断并置 truncated。

MESH_FACE_KINDS = {0: "plane", 1: "cylinder", 2: "cone", 3: "sphere", 4: "torus"}
MESH_MAX_EDGE_POINTS = 200000


def shape_maps():
    """OCP 8 把模板实例放在 OCP.collections，OCP 7 放在 OCP.TopTools。

    懒 import：万一某个 OCP 版本命名不同，只有 step.mesh 失败，不连累 health 等 op。
    """
    try:
        from OCP.collections import (
            IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as edge_faces,
            IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as index_map,
        )
        return index_map, edge_faces
    except Exception:
        from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape
        return TopTools_IndexedMapOfShape, TopTools_IndexedDataMapOfShapeListOfShape


def use_mm_units():
    """STEP 可能按米/英寸声明长度单位，OCCT 靠 xstep.cascade.unit 换算到 mm。

    默认值本来就是 MM；这里显式写一次，免得同进程里别处改过之后单位悄悄变了。
    """
    try:
        from OCP.Interface import Interface_Static
        Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    except Exception:
        pass


def mesh_triangulate(shape, deflection, angular, clean=False):
    """就地三角化；返回是否成功（三角形数由 mesh_triangle_count 另算）。

    clean=True 先丢掉已有三角化：BRepMesh 是增量的，已有更细的网格时它会直接
    沿用，加大 deflection 重试就不会有任何效果。
    """
    if clean:
        try:
            from OCP.BRepTools import BRepTools
            BRepTools.Clean_s(shape, True)
        except Exception:
            pass
    mesh = BRepMesh_IncrementalMesh(shape, deflection, False, angular, True)
    try:
        return bool(mesh.IsDone())
    except Exception:
        return False


def mesh_triangle_count(shape):
    total = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face(exp.Current())
        loc = TopLoc_Location()
        try:
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is not None:
                total += tri.NbTriangles()
        except Exception:
            pass
        exp.Next()
    return total


def mesh_face_info(adaptor, index, area):
    """faces[] 的一条：类型 + 面积 + 一个能拿去画标记的面法向/点 + 半径。

    plane 的 normal/point 是平面本身的法向与原点；cylinder/cone 是轴线方向与轴线
    上一点（不是表面法向，表面法向逐点不同）；sphere/torus 给半径与轴线。
    """
    kind = int(adaptor.GetType())
    entry = {"index": index, "kind": MESH_FACE_KINDS.get(kind, "other"), "areaMm2": rnd(area),
             "normal": [0.0, 0.0, 0.0], "point": [0.0, 0.0, 0.0]}
    try:
        if kind == 0:  # GeomAbs_Plane
            plane = adaptor.Plane()
            direction, location = plane.Axis().Direction(), plane.Location()
            entry["normal"] = [rnd(direction.X(), 6), rnd(direction.Y(), 6), rnd(direction.Z(), 6)]
            entry["point"] = [rnd(location.X(), 6), rnd(location.Y(), 6), rnd(location.Z(), 6)]
        elif kind == 1:  # GeomAbs_Cylinder
            cylinder = adaptor.Cylinder()
            direction, location = cylinder.Axis().Direction(), cylinder.Axis().Location()
            entry["normal"] = [rnd(direction.X(), 6), rnd(direction.Y(), 6), rnd(direction.Z(), 6)]
            entry["point"] = [rnd(location.X(), 6), rnd(location.Y(), 6), rnd(location.Z(), 6)]
            entry["radiusMm"] = rnd(cylinder.Radius(), 6)
        elif kind == 2:  # GeomAbs_Cone
            cone = adaptor.Cone()
            direction = cone.Axis().Direction()
            location = cone.Axis().Location()
            entry["normal"] = [rnd(direction.X(), 6), rnd(direction.Y(), 6), rnd(direction.Z(), 6)]
            entry["point"] = [rnd(location.X(), 6), rnd(location.Y(), 6), rnd(location.Z(), 6)]
            entry["radiusMm"] = rnd(cone.RefRadius(), 6)
        elif kind == 3:  # GeomAbs_Sphere
            sphere = adaptor.Sphere()
            center = sphere.Location()
            entry["point"] = [rnd(center.X(), 6), rnd(center.Y(), 6), rnd(center.Z(), 6)]
            entry["radiusMm"] = rnd(sphere.Radius(), 6)
        elif kind == 4:  # GeomAbs_Torus
            torus = adaptor.Torus()
            center = torus.Location()
            entry["point"] = [rnd(center.X(), 6), rnd(center.Y(), 6), rnd(center.Z(), 6)]
            entry["radiusMm"] = rnd(torus.MajorRadius(), 6)
    except Exception:
        pass
    return entry


def mesh_edge_polyline(edge, curve, length, deflection):
    """沿边采样成折线：直线 2 点；圆弧/样条至少 8 段，密集程度跟着曲边长度走。"""
    first, last = curve.FirstParameter(), curve.LastParameter()
    if curve.GetType() == GeomAbs_Line:
        samples = 2
    else:
        samples = max(8, min(96, int(math.ceil(length / max(deflection * 1.5, 0.05)))))
    points = []
    try:
        sampler = GCPnts_QuasiUniformAbscissa(curve, samples)
        if sampler.IsDone() and sampler.NbPoints() >= 2:
            for index in range(1, sampler.NbPoints() + 1):
                pnt = curve.Value(sampler.Parameter(index))
                points.append([rnd(pnt.X(), 6), rnd(pnt.Y(), 6), rnd(pnt.Z(), 6)])
    except Exception:
        points = []
    if len(points) < 2:
        points = []
        for index in range(samples):
            pnt = curve.Value(first + (last - first) * index / max(samples - 1, 1))
            points.append([rnd(pnt.X(), 6), rnd(pnt.Y(), 6), rnd(pnt.Z(), 6)])
    if len(points) < 2:
        pnt = curve.Value(first)
        points = [[rnd(pnt.X(), 6), rnd(pnt.Y(), 6), rnd(pnt.Z(), 6)]] * 2
    return points


def mesh_triangle_normal(points):
    """三点叉积（长度 = 2 倍面积）；退化三角形返回零向量。"""
    ax, ay, az = points[0]
    ux, uy, uz = points[1][0] - ax, points[1][1] - ay, points[1][2] - az
    vx, vy, vz = points[2][0] - ax, points[2][1] - ay, points[2][2] - az
    return (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)


def op_step_mesh(params):
    """STEP → 三角网格 + 边线框（单位 mm），带面索引与相邻面，供 3D 预览直接画。"""
    if not HAVE_OCP:
        raise RuntimeError(f"OCP not available: {OCP_ERROR}")
    ShapeIndexMap, EdgeFaceMap = shape_maps()
    path = params["path"]
    try:
        deflection = max(1e-4, min(float(params.get("deflectionMm") or 0.2), 50.0))
    except (TypeError, ValueError):
        deflection = 0.2
    try:
        angular = max(1e-3, min(float(params.get("angularDeflection") or 0.5), 2.0))
    except (TypeError, ValueError):
        angular = 0.5
    max_edges = max(0, int(params.get("maxEdges") or 4000))
    max_triangles = max(1, int(params.get("maxTriangles") or 200000))
    max_edge_points = max(0, int(params.get("maxEdgePoints") or MESH_MAX_EDGE_POINTS))
    area_tolerance = max(0.0, float(params.get("tolerance") or 0.0))

    use_mm_units()
    shape = read_step(path)

    face_map, edge_map, vertex_map = ShapeIndexMap(), ShapeIndexMap(), ShapeIndexMap()
    TopExp.MapShapes_s(shape, TopAbs_FACE, face_map)
    TopExp.MapShapes_s(shape, TopAbs_EDGE, edge_map)
    TopExp.MapShapes_s(shape, TopAbs_VERTEX, vertex_map)
    edge_faces_map = EdgeFaceMap()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, edge_faces_map)

    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    lo, hi = box.CornerMin(), box.CornerMax()
    bbox = [rnd(lo.X(), 6), rnd(lo.Y(), 6), rnd(lo.Z(), 6),
            rnd(hi.X(), 6), rnd(hi.Y(), 6), rnd(hi.Z(), 6)]
    center = [(bbox[0] + bbox[3]) / 2.0, (bbox[1] + bbox[4]) / 2.0, (bbox[2] + bbox[5]) / 2.0]

    truncated_triangles = False
    truncated_edges = False
    retried = False

    mesh_triangulate(shape, deflection, angular)
    triangle_total = mesh_triangle_count(shape)
    if triangle_total > max_triangles:
        # 只重试一次：按三角形数的平方根放大线性挠度，再不行就截断（预览能接受）。
        retry = min(50.0, deflection * math.sqrt(triangle_total / float(max_triangles)) * 1.05)
        if mesh_triangulate(shape, retry, angular, clean=True):
            retried = True
            retried_total = mesh_triangle_count(shape)
            if retried_total < triangle_total:
                deflection = retry
                triangle_total = retried_total

    vertices, normals, triangles, faces = [], [], [], []
    flip_votes = 0.0
    for face_index in range(face_map.Extent()):
        face = TopoDS.Face(face_map.FindKey(face_index + 1))
        props = GProp_GProps()
        try:
            BRepGProp.SurfaceProperties_s(face, props)
            area = props.Mass()
            centroid = props.CentreOfMass()
            centroid_point = (centroid.X(), centroid.Y(), centroid.Z())
        except Exception:
            area, centroid_point = 0.0, None
        try:
            face_info = mesh_face_info(BRepAdaptor_Surface(face), face_index, area)
        except Exception:
            face_info = {"index": face_index, "kind": "other", "areaMm2": rnd(area),
                         "normal": [0.0, 0.0, 0.0], "point": [0.0, 0.0, 0.0]}

        loc = TopLoc_Location()
        tri = None
        try:
            tri = BRep_Tool.Triangulation_s(face, loc)
        except Exception:
            tri = None
        face_normal = (0.0, 0.0, 0.0)
        if tri is not None:
            try:
                node_count, tri_count = tri.NbNodes(), tri.NbTriangles()
            except Exception:
                node_count, tri_count = 0, 0
            if tri_count > 0 and node_count > 0:
                transform = None if loc.IsIdentity() else loc.Transformation()
                base = len(vertices)
                for node_index in range(1, node_count + 1):
                    pnt = tri.Node(node_index)
                    if transform is not None:
                        pnt = pnt.Transformed(transform)
                    vertices.append([rnd(pnt.X(), 6), rnd(pnt.Y(), 6), rnd(pnt.Z(), 6)])
                reversed_face = face.Orientation() == TopAbs_REVERSED
                accum = [0.0, 0.0, 0.0]
                local_triangles = []
                for tri_index in range(1, tri_count + 1):
                    try:
                        a, b, c = tri.Triangle(tri_index).Get()
                    except Exception:
                        continue
                    ia, ib, ic = base + a - 1, base + b - 1, base + c - 1
                    if reversed_face:
                        ib, ic = ic, ib
                    cross = mesh_triangle_normal((vertices[ia], vertices[ib], vertices[ic]))
                    # 面积权重：叉积长度就是 2 倍面积，累加即面积加权法向。
                    accum = [accum[0] + cross[0], accum[1] + cross[1], accum[2] + cross[2]]
                    if area_tolerance > 0.0:
                        magnitude = math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2) / 2.0
                        if magnitude <= area_tolerance:
                            continue  # 退化三角形（面积过小）不进入三角形表
                    local_triangles.append([ia, ib, ic, face_index])
                magnitude = math.sqrt(accum[0] ** 2 + accum[1] ** 2 + accum[2] ** 2)
                if magnitude > 0.0:
                    face_normal = (accum[0] / magnitude, accum[1] / magnitude, accum[2] / magnitude)
                face_info["normal"] = [rnd(face_normal[0], 6), rnd(face_normal[1], 6), rnd(face_normal[2], 6)]
                if centroid_point is not None and area > 0.0:
                    outward = (centroid_point[0] - center[0], centroid_point[1] - center[1],
                               centroid_point[2] - center[2])
                    flip_votes += area * (outward[0] * face_normal[0] + outward[1] * face_normal[1]
                                          + outward[2] * face_normal[2])
                for _ in range(node_count):
                    normals.append([face_normal[0], face_normal[1], face_normal[2]])
                triangles.extend(local_triangles)
        faces.append(face_info)

    # 整块模型的法向自检：面积加权点积为负说明所有面都朝内，统一翻面。
    if flip_votes < 0.0:
        for index, normal in enumerate(normals):
            normals[index] = [-normal[0], -normal[1], -normal[2]]
        for index, triangle in enumerate(triangles):
            triangles[index] = [triangle[0], triangle[2], triangle[1], triangle[3]]
        for face_info in faces:
            normal = face_info.get("normal") or [0.0, 0.0, 0.0]
            face_info["normal"] = [-normal[0], -normal[1], -normal[2]]

    if len(triangles) > max_triangles:
        del triangles[max_triangles:]
        truncated_triangles = True

    edges = []
    total_edge_points = 0
    for edge_index in range(edge_map.Extent()):
        edge = TopoDS.Edge(edge_map.FindKey(edge_index + 1))
        if edge.IsNull():
            continue
        try:
            curve = BRepAdaptor_Curve(edge)
        except Exception:
            continue
        is_line = curve.GetType() == GeomAbs_Line
        is_circle = curve.GetType() == GeomAbs_Circle
        length = 0.0
        try:
            linear = GProp_GProps()
            BRepGProp.LinearProperties_s(edge, linear)
            length = linear.Mass()
        except Exception:
            length = 0.0
        try:
            points = mesh_edge_polyline(edge, curve, length, deflection)
        except Exception:
            continue
        if len(points) < 2:
            continue
        adjacent = []
        try:
            for ancestor in edge_faces_map.FindFromKey(edge):
                face_index = face_map.FindIndex(ancestor) - 1
                if face_index >= 0 and face_index not in adjacent:
                    adjacent.append(face_index)
        except Exception:
            adjacent = []
        entry = {
            "index": len(edges),
            "id": None,
            "isCircle": bool(is_circle),
            "lengthMm": rnd(length),
            "startMm": points[0],
            "endMm": points[-1],
            "midMm": points[len(points) // 2],
            "faces": adjacent[:2],
            "polyline": points,
            "isLine": bool(is_line),
        }
        if is_circle:
            try:
                entry["radiusMm"] = rnd(curve.Circle().Radius(), 6)
            except Exception:
                entry["radiusMm"] = None
        edges.append(entry)
        total_edge_points += len(points)

    if max_edges and len(edges) > max_edges:
        edges = edges[:max_edges]
        truncated_edges = True
        total_edge_points = sum(len(entry["polyline"]) for entry in edges)

    # 折线总点数上限：超了就整体按步长降采样（保留首尾），并标记截断。
    if max_edge_points and total_edge_points > max_edge_points:
        stride = int(math.ceil(total_edge_points / float(max_edge_points)))
        if stride > 1:
            for entry in edges:
                points = entry["polyline"]
                if len(points) > 2:
                    kept = points[::stride]
                    if kept[-1] != points[-1]:
                        kept.append(points[-1])
                    entry["polyline"] = kept if len(kept) >= 2 else [points[0], points[-1]]
                    entry["midMm"] = entry["polyline"][len(entry["polyline"]) // 2]
            truncated_edges = True

    return {
        "path": path,
        "format": "step",
        "units": "mm",
        "bbox": bbox,
        "faceCount": len(faces),
        "edgeCount": len(edges),
        "vertexCount": len(vertices),
        "triangleCount": len(triangles),
        "vertices": vertices,
        "normals": normals,
        "normalsMode": "face",
        "triangles": triangles,
        "faces": faces,
        "edges": edges,
        "brepVertexCount": vertex_map.Extent(),
        "deflections": {"linearMm": rnd(deflection, 6), "angularRad": rnd(angular, 6), "retried": retried},
        "truncated": {"triangles": truncated_triangles, "edges": truncated_edges},
    }


def op_image_analyze(params):
    if not HAVE_PIL:
        raise RuntimeError("Pillow not available")
    path = params["path"]
    threshold = int(params.get("threshold", 128))
    image = Image.open(path).convert("L")
    width, height = image.size
    pixels = list(image.getdata())
    dark = [(index % width, index // width) for index, value in enumerate(pixels) if value < threshold]
    if not dark:
        return {"size": [width, height], "darkPixels": 0, "bbox": None, "coverage": 0.0, "grid": []}
    xs = [x for x, _ in dark]
    ys = [y for _, y in dark]
    grid = []
    cells = int(params.get("grid", 16))
    counts = [[0] * cells for _ in range(cells)]
    for x, y in dark:
        counts[min(cells - 1, y * cells // height)][min(cells - 1, x * cells // width)] += 1
    for row in range(cells):
        for col in range(cells):
            if counts[row][col]:
                grid.append({"row": row, "col": col, "dark": counts[row][col]})
    return {
        "size": [width, height], "darkPixels": len(dark),
        "bbox": [min(xs), min(ys), max(xs) + 1, max(ys) + 1],
        "coverage": rnd(len(dark) / (width * height), 6), "grid": grid, "threshold": threshold,
    }


OPS = {
    "health": op_health,
    "step.info": op_step_info,
    "step.hlr": op_step_hlr,
    "step.section": op_step_section,
    "step.faces": op_step_faces,
    "step.mesh": op_step_mesh,
    "step.diff": op_step_diff,
    "image.analyze": op_image_analyze,
}


def handle(request):
    request_id = request.get("id")
    op = request.get("op")
    if op not in OPS:
        return {"id": request_id, "ok": False, "error": {"code": "UNKNOWN_OP", "message": op}}
    try:
        return {"id": request_id, "ok": True, "op": op, **OPS[op](request)}
    except Exception as error:
        return {"id": request_id, "ok": False, "op": op,
                "error": {"code": "ANALYSIS_FAILED", "message": str(error), "trace": traceback.format_exc(limit=4)}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": {"code": "BAD_REQUEST", "message": "invalid json"}}), flush=True)
            continue
        print(json.dumps(handle(request), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
