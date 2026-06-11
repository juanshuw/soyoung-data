const P = require('./pipeline.js'); const fs = require('fs');
const recPath = process.argv[2] || 'soyoung_full_report.csv';
const prdPath = process.argv[3] || 'product.csv';
const D = P.process(fs.readFileSync(recPath,'utf8'), fs.readFileSync(prdPath,'utf8'));
delete D._weekStart; // 函数不入JSON
let html = fs.readFileSync('site_template.html','utf8');
html = html.replace('var EMBED = null; /*__EMBED_DATA__*/', 'var EMBED = '+JSON.stringify(D)+'; /*__EMBED_DATA__*/');
fs.mkdirSync('docs',{recursive:true});
fs.writeFileSync('docs/index.html', html);
fs.writeFileSync('docs/.nojekyll','');
console.log('✓ baked docs/index.html', (html.length/1048576).toFixed(2)+'MB  业务日至', D.kpi.date_max, '| 城',D.kpi.n_city,'店',D.kpi.n_shop,'品',D.kpi.n_spu);
