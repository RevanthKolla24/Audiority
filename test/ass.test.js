const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');
const { discoverMedia } = require('../src/imports');

test('real FFmpeg: ASS styles, effects, dispositions, font payloads and external subtitles survive audio conversion', {timeout:60000}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'audiority-ass-'));
  try {
    const season = path.join(directory,'Anime','Season 01'); await fs.mkdir(season,{recursive:true});
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Test Font,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\pos(120,80)\\fad(100,100)\\t(0,500,\\frz30)\\k20}Styled anime sign\n`;
    const sidecar = path.join(season,'Episode 01.eng.forced.ass'); await fs.writeFile(sidecar,ass);
    // Payload fixture tests attachment preservation, not glyph rendering.
    const font = path.join(directory,'fixture.ttf'); await fs.writeFile(font,Buffer.from('font attachment preservation fixture'));
    const input = path.join(season,'Episode 01.mkv'); const tools = toolPaths(); const engine = new Engine(tools);
    await run(tools.ffmpeg,['-v','error','-f','lavfi','-i','color=s=64x64:r=10:d=1','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-i',sidecar,'-map','0:v','-map','1:a','-map','2:s','-c:v','mpeg4','-c:a','flac','-c:s','ass','-metadata:s:s:0','language=eng','-metadata:s:s:0','title=Styled Signs','-disposition:s:0','default+forced','-attach',font,'-metadata:s:t:0','filename=fixture.ttf','-metadata:s:t:0','mimetype=application/x-truetype-font','-t','1',input]);
    const candidates = []; for await (const candidate of discoverMedia([path.join(directory,'Anime')])) candidates.push(candidate);
    const item = await engine.inspect(input); Object.assign(item,candidates[0]);
    assert.equal(item.subtitleInfo.ass,1); assert.equal(item.subtitleInfo.fonts,1);
    const out = path.join(directory,'Converted'); await fs.mkdir(out);
    const result = await engine.convert(item,out);
    assert.ok(result.output.includes(path.join('Anime','Season 01'))); assert.equal(result.sidecars.length,1);
    assert.equal(path.basename(result.sidecars[0]),'Episode 01.audiority.eng.forced.ass');
    assert.equal(await fs.readFile(result.sidecars[0],'utf8'),ass);
    const source = await engine.probe(input); const target = await engine.probe(result.output);
    const subtitle = target.streams.find(s => s.codec_type === 'subtitle');
    assert.equal(subtitle.tags.title,'Styled Signs'); assert.equal(subtitle.disposition.forced,1);
    await engine.verifySubtitles(item,result.output);
    const second = await engine.convert(item,out); assert.notEqual(second.output,result.output); assert.equal(second.sidecars.length,1);
    const args = ['-v','error','-select_streams','s:0','-show_streams','-show_packets','-show_data_hash','sha256','-show_entries','stream=extradata_hash:packet=data_hash','-of','json'];
    assert.deepEqual(JSON.parse((await run(tools.ffprobe,[...args,result.output])).stdout),JSON.parse((await run(tools.ffprobe,[...args,input])).stdout));
    assert.equal(source.streams.length,target.streams.length);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});