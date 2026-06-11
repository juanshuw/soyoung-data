# soyoung-data

新氧高频数据**在线 BI 看板**（公开免登录）。

- `docs/index.html` — 看板页面，**已把处理后的聚合数据内嵌**（每日由 GitHub Action 自动重建）。GitHub Pages 从 `main/docs` 发布。
- `site_template.html` / `pipeline.js` / `build_site.js` — 构建工具（看板模板、浏览器内数据处理引擎、烤数据脚本）。

**本仓库不含任何原始 CSV**：原始逐快照数据只保留在私有爬虫仓库；这里只发布看板与图表所需的聚合数字，外部无法下载原始数据文件。

在线网址：`https://juanshuw.github.io/soyoung-data/`

构建（CI 自动执行）：`node build_site.js <reception.csv> <product.csv>` → 生成 `docs/index.html`。
