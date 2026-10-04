"""Generate a small factual image fixture with a nonce absent from the prompt."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json,secrets,sys
folder=Path(sys.argv[1]).resolve();folder.mkdir(parents=True,exist_ok=True)
nonce=''.join(str(secrets.randbelow(10)) for _ in range(6))
image=Image.new('RGB',(720,380),'white');draw=ImageDraw.Draw(image)
font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',78)
draw.text((50,35),nonce,fill='black',font=font)
draw.rectangle((60,200,170,310),fill='#e02020')
draw.ellipse((295,200,405,310),fill='#176cdb')
draw.polygon([(580,195),(520,315),(640,315)],fill='#169447')
image.save(folder/'visual-check.png')
(folder/'expected.json').write_text(json.dumps({'nonce':nonce,'colors':['red','blue','green'],'shapes':['square','circle','triangle']}),encoding='utf-8')
print('Vision fixture prepared; nonce is stored separately from the prompt')
