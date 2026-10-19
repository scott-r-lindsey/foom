"""Informational pixel comparison; Pillow required. Run from the repository root.
RGB tolerance 32 ignores small antialiasing differences. Layout/raster differences
are reported, never hidden by an automatic golden-image update.
"""
from pathlib import Path
import json
from PIL import Image, ImageChops, ImageDraw
root = Path('spikes/xterm-webgl/results/software')
data = json.loads((root / 'visual-security.json').read_text())
states = {(row['mode'], row['case']): row['state'] for row in data['matrix'] if 'case' in row}
results, thumbnails = [], []
for source in sorted((root / 'visual').glob('dom-*.png')):
    name = source.stem[4:]
    dom = Image.open(source).convert('RGB')
    webgl = Image.open(root / 'visual' / f'webgl-{name}.png').convert('RGB')
    assert dom.size == webgl.size
    a, b = states['dom', name], states['webgl', name]
    for key in ('lines', 'font', 'fontSize', 'theme', 'selection', 'cursor', 'rows'):
        assert a[key] == b[key], (name, key, a[key], b[key])
    diff = ImageChops.difference(dom, webgl)
    changed = sum(max(pixel) > 32 for pixel in diff.getdata())
    # Both renderers must actually draw text, not merely an empty background.
    for image in (dom, webgl):
        background = image.getpixel((image.width - 1, image.height - 1))
        assert sum(max(abs(x-y) for x,y in zip(pixel,background)) > 32 for pixel in image.getdata()) > 100
    results.append({'case': name, 'pixels': dom.width*dom.height,
                    'differentPixelsTolerance32': changed,
                    'differentFraction': changed/(dom.width*dom.height),
                    'domColumns': a['cols'], 'webglColumns': b['cols'],
                    'logicalContentAndThemeMatch': True})
    tile = Image.new('RGB', (1000, 230), '#444444')
    draw = ImageDraw.Draw(tile)
    for index,(image,mode) in enumerate(((dom,'DOM'),(webgl,'WebGL'))):
        preview = image.copy(); preview.thumbnail((495,200))
        tile.paste(preview,(500*index,25)); draw.text((500*index+4,5),f'{mode}: {name}',fill='white')
    thumbnails.append(tile)
contact = Image.new('RGB',(1000,230*len(thumbnails)))
for index,tile in enumerate(thumbnails): contact.paste(tile,(0,index*230))
contact.save(root / 'visual-contact.png')
(root / 'visual-diff.json').write_text(json.dumps({'rgbTolerance':32,'comparisons':results},indent=2)+'\n')
print(json.dumps(results,indent=2))
