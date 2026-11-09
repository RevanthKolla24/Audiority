const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Engine, run } = require('../src/engine');
const { toolPaths } = require('../src/tools');

test('real remux preserves video packets, styled ASS and font attachments, and rejects changed video', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiority-remux-preservation-'));
  try {
    const tools = toolPaths(), engine = new Engine(tools);
    const subtitle = path.join(dir, 'styled.ass'), font = path.join(dir, 'fixture.ttf');
    await fs.writeFile(subtitle, `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Signs,Fixture,28,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Signs,,0,0,0,,{\\pos(320,45)\\fad(100,100)\\bord3}Styled sign {\\i1}italic
`);
    // A deterministic attachment payload checks byte preservation, not font rendering.
    await fs.writeFile(font, Buffer.from('fixture font payload\0\1\2'));
    const input = path.join(dir, 'input.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', subtitle,
      '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'mpeg4', '-c:a', 'flac', '-c:s', 'copy',
      '-attach', font, '-metadata:s:t:0', 'mimetype=application/x-truetype-font', '-t', '1', input]);
    const item = await engine.inspect(input);
    const result = await engine.convert(item, dir);
    await engine.verifyVideo(item, result.output);
    await engine.verifySubtitles(item, result.output);
    const output = await engine.probe(result.output);
    assert.equal(output.streams.filter(stream => stream.codec_type === 'subtitle').length, 1);
    assert.equal(output.streams.find(stream => stream.codec_type === 'subtitle').codec_name, 'ass');
    assert.equal(output.streams.filter(stream => stream.codec_type === 'attachment').length, 1);
    const changed = path.join(dir, 'changed.mkv');
    await run(tools.ffmpeg, ['-v', 'error', '-i', result.output, '-map', '0:v', '-vf', 'negate', '-c:v', 'mpeg4', changed]);
    await assert.rejects(engine.verifyVideo(item, changed), /copied video content or format changed/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(engine.verifyVideo(item, result.output, controller.signal), /Cancelled/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});