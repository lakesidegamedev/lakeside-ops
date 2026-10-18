const {test}=require('node:test'),assert=require('node:assert/strict');const {formatEntry}=require('./src/formatter.cjs');
test('a normal day formats its real duration',()=>{assert.equal(formatEntry('2026-10-01 09:15-17:45 Project Alpha #billable'),'2026-10-01 Project Alpha 8h30m [billable]');});
test('an untagged entry has no tag list',()=>{assert.equal(formatEntry('2026-10-02 08:00-12:00 Support'),'2026-10-02 Support 4h00m');});
