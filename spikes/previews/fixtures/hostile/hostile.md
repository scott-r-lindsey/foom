# Hostile Markdown

<script>window.__pwned = "script"</script>

<img src="x" onerror="window.__pwned = 'onerror'">

<iframe src="http://127.0.0.1:PORT/md-iframe"></iframe>

[javascript link](javascript:window.__pwned='js-link')
[vbscript link](vbscript:msgbox)
[data link](data:text/html,<script>alert(1)</script>)
[file link](file:///etc/hostname)
[escape link](../../../../etc/hostname)
[other markdown](../demo/other.md)

![remote image](http://127.0.0.1:PORT/md-image)
![data image](data:image/svg+xml;base64,PHN2Zy8+)

<a href="https://example.com" onclick="window.__pwned='onclick'">raw anchor</a>

```html
<script>window.__pwned = "fence"</script>
```
