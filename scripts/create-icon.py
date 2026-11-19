"""Generate the app's code-defined icon. Requires Pillow only when regenerating."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
output = root / 'assets'
output.mkdir(exist_ok=True)
size = 1024
image = Image.new('RGBA', (size, size))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((20, 20, size-20, size-20), radius=140, fill='#2563eb')
points = [(280, 520), (448, 680), (758, 360)]
draw.line(points, fill='white', width=84, joint='curve')
for x, y in points:
    draw.ellipse((x-42, y-42, x+42, y+42), fill='white')
icon = image.resize((256, 256), Image.Resampling.LANCZOS)
icon.save(output / 'icon.png')
icon.save(output / 'icon.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
print('Created assets/icon.png and assets/icon.ico')
