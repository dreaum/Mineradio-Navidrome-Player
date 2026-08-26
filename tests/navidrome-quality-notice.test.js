'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(
  __dirname,
  '..',
  'public',
  'js',
  'modules',
  '05-playback',
  '00-api-quality-output.js'
), 'utf8');

function readFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index++) {
    if (source[index] === '{') {
      depth++;
      opened = true;
    } else if (source[index] === '}') {
      depth--;
      if (opened && depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not read ${name}`);
}

test('Navidrome quality notice uses measured transcoded bitrate instead of source bitrate', async () => {
  const notices = [];
  const media = {
    duration: 295,
    readyState: 1,
    addEventListener() {},
  };
  const context = {
    window: {
      navidrome: {
        mediaInfo: async () => ({
          ok: true,
          value: { ready: true, bitRate: 214000 },
        }),
      },
    },
    audio: media,
    trackSwitchToken: 17,
    isFinite,
    Number,
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    playbackResolvedQualityText: (data) => `最高 192 kbps · ${Math.round(Number(data.br) / 1000)} kbps`,
    showSourceFallbackNotice: (title, body) => notices.push({ title, body }),
  };

  vm.runInNewContext(`${readFunction('scheduleNavidromeQualitySwitchNotice')}\nthis.schedule = scheduleNavidromeQualitySwitchNotice;`, context);
  const scheduled = context.schedule(media, {
    url: 'http://127.0.0.1:3456/api/navidrome-media?kind=stream&cap=test',
    level: '192',
    br: 796000,
  }, {
    duration: 295,
    bitRate: 796,
  }, 17);

  assert.equal(scheduled, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /214 kbps/);
  assert.doesNotMatch(notices[0].body, /796 kbps/);
});
