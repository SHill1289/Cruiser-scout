"""Bounded public-source access check; no credentials or challenge bypass."""
import json, sys, time, urllib.request, urllib.robotparser
from pathlib import Path
sys.path.insert(0, "src")
from carsandbids import SEARCH_SCRIPT
from selenium import webdriver
from selenium.webdriver.support.ui import WebDriverWait

out=Path(".source-check/results");out.mkdir(parents=True,exist_ok=True)
report=[]
options=webdriver.ChromeOptions()
options.page_load_strategy="eager"
for arg in ("--headless=new","--no-sandbox","--disable-dev-shm-usage","--window-size=1280,900"):
    options.add_argument(arg)
driver=webdriver.Chrome(options=options);driver.set_page_load_timeout(35)
checks=[
 ("carsandbids","https://carsandbids.com/search/lexus/lx","https://carsandbids.com/robots.txt"),
 ("cars.com","https://www.cars.com/shopping/lexus-lx_470/","https://www.cars.com/robots.txt"),
]
try:
 for source,url,robots in checks:
    item={"source":source,"url":url};report.append(item)
    try:
        req=urllib.request.Request(robots,headers={"User-Agent":"CruiserScout"})
        with urllib.request.urlopen(req,timeout=20) as response: rules=response.read(1000000).decode()
        parser=urllib.robotparser.RobotFileParser();parser.parse(rules.splitlines())
        item["robots_allowed"]=parser.can_fetch("CruiserScout",url)
        if not item["robots_allowed"]:continue
        try:
            req=urllib.request.Request(url,headers={"User-Agent":"CruiserScout"})
            with urllib.request.urlopen(req,timeout=25) as response:
                html=response.read(6000000).decode(errors="replace")
            item["http"]={"bytes":len(html),"challenge":any(s in html.lower() for s in ["verify you are human","just a moment...","access denied"])}
            (out/(source+"-http.html")).write_text(html,encoding="utf-8")
        except Exception as e:item["http_error"]=str(e)[:200]
        try:driver.get(url)
        except Exception as e:item["navigation_error"]=type(e).__name__
        time.sleep(5)
        item["title"]=driver.title;item["final_url"]=driver.current_url
        item["text_preview"]=driver.find_element("tag name","body").text[:600]
        if source=="carsandbids":
            try:item["search"]=WebDriverWait(driver,15).until(lambda d:d.execute_script(SEARCH_SCRIPT))
            except Exception as e:item["search_error"]=type(e).__name__
        else:
            item["links"]=driver.execute_script("return [...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href).filter(u=>u.includes('/vehicledetail/')))];")
        if item.get("search") or item.get("links"):
            (out/(source+".html")).write_text(driver.page_source,encoding="utf-8")
        # Repeat once to establish that successful access was not a one-off.
        if item.get("search") or item.get("links"):
            time.sleep(3);driver.get(url);time.sleep(5)
            item["repeat_title"]=driver.title
            item["repeat_count"]=driver.execute_script("return document.querySelectorAll('a[href*=\"/auctions/\"],a[href*=\"/vehicledetail/\"]').length")
    except Exception as e:item["error"]=type(e).__name__+": "+str(e)[:200]
finally:driver.quit()
(out/"report.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
print(json.dumps(report,indent=2))
