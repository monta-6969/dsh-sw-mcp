import argparse, json, os, sys
from PIL import Image, ImageDraw, ImageFont

def font(size, bold=False):
    for name in (["msyhbd.ttc","msyh.ttc"] if bold else ["msyh.ttc","msyhbd.ttc"]):
        for root in (r"C:\Windows\Fonts",):
            p = os.path.join(root, name)
            if os.path.exists(p):
                try: return ImageFont.truetype(p, size)
                except Exception: pass
    return ImageFont.load_default()

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--title', default='')
ap.add_argument('--subtitle', default='')
ap.add_argument('--images', required=True, help='comma separated, order: iso,front,top,section')
ap.add_argument('--labels', default='等轴测,前视,上视,剖视')
ap.add_argument('--notes', default='')
ap.add_argument('--panel', type=int, default=470)
a = ap.parse_args()

imgs = [p for p in a.images.split(',') if p and os.path.exists(p)]
labels = a.labels.split(',')
cell_w, cell_h = 660, 470
cols, rows = 2, 2
W = cols*cell_w + a.panel
H = rows*cell_h + 96
card = Image.new('RGB', (W, H), (250, 250, 250))
d = ImageDraw.Draw(card)
f_title = font(30, True); f_sub = font(19); f_lab = font(17, True); f_note = font(17)

d.rectangle([0,0,W,84], fill=(28,32,38))
d.text((26,16), a.title, font=f_title, fill=(255,255,255))
d.text((26,54), a.subtitle, font=f_sub, fill=(186,196,208))

for i, p in enumerate(imgs[:4]):
    try:
        im = Image.open(p).convert('RGB')
    except Exception as e:
        continue
    im.thumbnail((cell_w-16, cell_h-46), Image.LANCZOS)
    x = (i % cols)*cell_w + (cell_w-im.width)//2
    y = 84 + (i//cols)*cell_h + 34
    card.paste(im, (x, y))
    lab = labels[i] if i < len(labels) else ''
    d.rectangle([(i%cols)*cell_w+6, 84+(i//cols)*cell_h+4, (i%cols)*cell_w+6+len(lab)*20+22, 84+(i//cols)*cell_h+30], fill=(224,229,236))
    d.text(((i%cols)*cell_w+16, 84+(i//cols)*cell_h+8), lab, font=f_lab, fill=(28,32,38))

px = cols*cell_w
d.rectangle([px,0,px+2,H], fill=(200,206,214))
d.rectangle([px,0,W,H], fill=(245,246,248))
d.text((px+18, 16), '审查记录', font=font(22, True), fill=(28,32,38))
y = 58
for line in a.notes.split('\n'):
    if not line.strip():
        y += 8; continue
    color = (28,32,38)
    if line.startswith('!'): color = (176,42,42)
    elif line.startswith('*'): color = (30,110,60)
    d.text((px+18, y), line.lstrip('!*'), font=f_note, fill=color)
    y += 26
    if y > H-30: break

card.save(a.out, 'PNG')
print(json.dumps({'out': a.out, 'w': W, 'h': H, 'panels': len(imgs)}, ensure_ascii=False))