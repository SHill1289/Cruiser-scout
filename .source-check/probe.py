import json, urllib.request, urllib.robotparser, xml.etree.ElementTree as ET
from pathlib import Path
url="https://carsandbids.com/rss.xml"
parser=urllib.robotparser.RobotFileParser()
parser.parse(urllib.request.urlopen("https://carsandbids.com/robots.txt",timeout=25).read().decode().splitlines())
assert parser.can_fetch("CruiserScout",url)
report=[]
for i in range(2):
    with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"CruiserScout"}),timeout=25) as r:
        xml=r.read(2000000).decode()
    root=ET.fromstring(xml)
    items=root.findall("./channel/item")
    report.append({"attempt":i+1,"items":len(items),"lexus":[x.findtext("title") for x in items if "Lexus LX" in x.findtext("title","")]})
out=Path(".source-check/results");out.mkdir(parents=True,exist_ok=True)
(out/"rss-report.json").write_text(json.dumps(report,indent=2)+"\n")
print(json.dumps(report))
