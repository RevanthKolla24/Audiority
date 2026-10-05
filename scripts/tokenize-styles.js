// One-time migration from fixed legacy palettes to shared theme colors.
const fs = require('node:fs');
const path = require('node:path');
const groups = {
  background: ['#f6f6f4','#111522'], surface: ['#ffffff','#fff','#fafbf7','#181e2c','#191f2e','#161d2b','#1a2233'],
  sidebar: ['#edede8'], text: ['#24272b','#30352f','#252b24','#e9edf6','#c3ccdd'],
  muted: ['#727671','#676d64','#787d73','#778071','#737b6e','#93978d','#828978','#7b8272','#92988a','#8998b2','#a0acc4','#9ba8c0','#98a6bf','#a3b0c7','#8f9eb8','#72829e','#aab5c9','#868a80','#56614e','#63765a','#66725f','#737b6b'],
  accent: ['#365f52','#88e1c2','#5b7050','#48613e'], accentText: ['#12231d'],
  border: ['#deded8','#d3d5ce','#d0d3ca','#d8ddd2','#cdd9c9','#b8c4b3','#eceee7','#cdd3c6','#cad6be','#b9c6ae','#30394d','#293247','#3d4b61','#252e40','#465570','#546881'],
  hover: ['#edf0e9','#294b40','#f0f3ed','#e5eee1','#eef2e9','#f5f7f1','#e8f0e2','#213333','#30433e'],
  warning: ['#916630','#975526','#9b673b','#8b6f3f','#edc58c'], warningBackground: ['#faf5e9','#f8eade','#dfcca5'],
  danger: ['#a44236','#a44537','#f1a5a5'], dangerBackground: ['#faeae4']
};
const mapping = Object.fromEntries(Object.entries(groups).flatMap(([token, colors]) => colors.map(color => [color, `var(--theme-${token})`])));
for (const file of ['style.css','setup.css','desktop.css']) {
  const target = path.join(__dirname, '..', 'src', 'ui', file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/#[0-9a-fA-F]{3,8}\b/g, color => mapping[color.toLowerCase()] || color));
}
console.log('Theme token migration complete.');