import pathlib
ROOT = pathlib.Path('d:/insta-yt-automation/youtubepilot')
q = chr(39)
for page in ['home.ejs', 'login.ejs', 'register.ejs']:
    p = ROOT / 'views' / page
    txt = p.read_text(encoding='utf-8')
    inc = '<%- include(' + q + 'partials/head' + q + ') %>'
    css = '<link rel="stylesheet" href="/assets/cinematic.css">'
    if css not in txt:
        txt = txt.replace(inc, inc + '\n' + css)
        p.write_text(txt, encoding='utf-8')