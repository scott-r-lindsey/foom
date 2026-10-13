// Fixture-only uncooperative writer, no model or network.
const fs=require('node:fs');
process.on('message',m=>{if(m.quit){process.disconnect();return;}fs.writeFileSync(m.file,m.text);process.send({written:true});});
process.send({ready:true});
