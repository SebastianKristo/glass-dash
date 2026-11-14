"""Layout-test for Hytte: skjermbilder og sjekk av horisontal scroll på flere bredder og zoomnivåer.
Bruk:  pip install playwright && playwright install chromium
       HYTTE_URL=http://localhost:8090 HYTTE_PW=passord python3 tests/layout.py
"""
import os, sys
from playwright.sync_api import sync_playwright
URL = os.environ.get('HYTTE_URL', 'http://localhost:8090'); PW = os.environ.get('HYTTE_PW', '')
OUT = os.environ.get('OUT', 'layout-shots'); os.makedirs(OUT, exist_ok=True)
WIDTHS = [390, 768, 1280, 1920, 2560]; ZOOMS = [0.5, 0.67, 1, 1.5, 2]
VIEWS = {'oversikt': '/', 'synk': '/synk', 'filer': '/filer', 'innstillinger': '/innstillinger'}
CHECK = """() => { const r = []; const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) r.push('horisontal scroll ' + document.documentElement.scrollWidth + '>' + W);
  for (const c of document.querySelectorAll('.card')) { const b = c.getBoundingClientRect(); if (b.right > W + 1) r.push('kort utenfor: ' + (c.className)); }
  return r }"""
fails = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    def run(w, z, h=1000):
        global fails
        ctx = b.new_context(viewport={'width': int(w / z), 'height': int(h / z)}, device_scale_factor=z)
        pg = ctx.new_page(); pg.goto(URL); pg.wait_for_timeout(800)
        if pg.query_selector('#pw'): pg.fill('#pw', PW); pg.keyboard.press('Enter'); pg.wait_for_timeout(1500)
        for name, path in VIEWS.items():
            pg.goto(URL + path); pg.wait_for_timeout(1200)
            errs = pg.evaluate(CHECK)
            pg.screenshot(path=f'{OUT}/{name}-{w}-z{int(z*100)}.png', full_page=True)
            if errs: fails += 1; print(f'✕ {name} {w}px zoom {int(z*100)}%: {errs[:3]}')
        ctx.close()
    for w in WIDTHS: run(w, 1)
    for z in ZOOMS: run(1440, z)
    b.close()
print('OK' if not fails else f'{fails} feil'); sys.exit(1 if fails else 0)
