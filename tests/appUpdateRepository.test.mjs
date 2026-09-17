import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsCommonJs } from './helpers/loadTsCommonJs.mjs';

test('app source is GitHub-only while independent asset endpoints stay upstream', () => {
 const app = loadTsCommonJs('src/main/update/updateSources.ts');
 for (const source of ['atomgit', 'github', 'custom', undefined, 'invalid']) {
  assert.equal(app.normalizeUpdateSource(source), 'github');
  assert.equal(app.updateSourceFeedUrl(source, 'https://atomgit.com'), null);
  assert.equal(app.updateSourceLatestReleaseUrl(source), null);
 }
 assert.equal(app.updateSourceOptions().length, 1);
 const repo = loadTsCommonJs('src/main/update/releaseRepo.ts');
 assert.equal(repo.RELEASES_URL, 'https://github.com/jintongxu/PiDeck/releases');
 const shared = loadTsCommonJs('src/shared/updateSources.ts');
 assert.equal(shared.atomGitFeedUrl(), 'https://atomgit.com/ayuayue/PiDeck/releases/download/latest');
});

test('packaged updater pins provider despite env, explicit overrides and stale config', () => {
 const calls = [];
 const updater = {setFeedURL: value => calls.push(value)};
 const env = { PIDEK_UPDATE_FEED_URL: 'https://atomgit.com/ayuayue/PiDeck', PIDECK_E2E: '1' };
 const {createRealAutoUpdater} = loadTsCommonJs('src/main/update/createAutoUpdater.ts', {
  globals: {process: { env, platform: 'win32', resourcesPath: 'resources' }},
  stubs: {electron: {app: {isPackaged: true, getAppPath: () => 'app', getPath: () => 'user'}},
   'node:fs': {existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {}},
   'electron-updater': {autoUpdater: updater}}
 });
 const wrapper = createRealAutoUpdater({feedUrl: 'https://github.com/ayuayue/PiDeck'});
 wrapper.setFeedUrl('https://atomgit.com/ayuayue/PiDeck');
 assert.ok(calls.length > 0);
 for (const value of calls) assert.deepEqual(JSON.parse(JSON.stringify(value)), {provider: 'github', owner: 'jintongxu', repo: 'PiDeck'});
});

test('publish metadata and app update UI do not expose upstream or AtomGit', () => {
 const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
 assert.equal(pkg.build.publish.owner, 'jintongxu');
 const ui = readFileSync('src/renderer/src/components/app/settings/UpdateSourceSetting.tsx', 'utf8');
 assert.ok(!ui.includes('updateSourceAtomGit'));
 assert.ok(!ui.includes('checkUpdateMirrors'));
});

test('app changelog has no upstream/AtomGit fallback even for legacy settings', () => {
 const {buildChangelogUrls, ChangelogService} = loadTsCommonJs('src/main/update/ChangelogService.ts');
 for (const source of ['github', 'atomgit']) {
  const urls = buildChangelogUrls({source, language: 'zh'});
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://raw.githubusercontent.com/jintongxu/PiDeck/main/CHANGELOG.zh-CN.md');
 }
 assert.equal(new ChangelogService().changelogPageUrl(), 'https://github.com/jintongxu/PiDeck/blob/main/CHANGELOG.zh-CN.md');
});

test('unpackaged controlled feed injection remains available for E2E', () => {
 const calls = [];
 const {createRealAutoUpdater} = loadTsCommonJs('src/main/update/createAutoUpdater.ts', {
  globals: {process: {env: {PIDEK_UPDATE_FEED_URL: 'http://127.0.0.1:1234'}, platform: 'win32', resourcesPath: 'resources'}},
  stubs: {electron: {app: {isPackaged: false, getAppPath: () => 'app', getPath: () => 'user'}},
   'node:fs': {existsSync: () => true},
   'electron-updater': {autoUpdater: {setFeedURL: value => calls.push(value)}}}
 });
 const wrapper = createRealAutoUpdater();
 wrapper.setFeedUrl(null);
 assert.equal(calls.length, 1);
 assert.equal(calls[0].url, 'http://127.0.0.1:1234');
});

test('mac manual checker requests the real fork release URL', async () => {
 const {createMacManualUpdateChecker} = loadTsCommonJs('src/main/update/macManualUpdate.ts', {stubs: {electron: {net: {}}}});
 let requested;
 const checker = createMacManualUpdateChecker({fetchLatestRelease: async url => {
  requested = url;
  return {ok: true, status: 200, url: 'https://github.com/jintongxu/PiDeck/releases/tag/v9.0.0'};
 }});
 assert.equal((await checker('0.7.6')).hasUpdate, true);
 assert.equal(requested, 'https://github.com/jintongxu/PiDeck/releases/latest');
});
