import { app } from 'electron';
import { resolveDesktopVideoLink } from './video-link-resolver.ts';
import { downloadVideoForCopy } from './video-copy-download.ts';

const input = process.env.CC_VIDEO_RESOLVER_SMOKE_URL;
if (!input) throw new Error('CC_VIDEO_RESOLVER_SMOKE_URL is required');

app.disableHardwareAcceleration();
process.stdout.write('VIDEO_RESOLVER_SMOKE_WAITING_FOR_APP\n');
void app.whenReady().then(async () => {
  process.stdout.write('VIDEO_RESOLVER_SMOKE_APP_READY\n');
  try {
    process.stdout.write('VIDEO_RESOLVER_SMOKE_RESOLVING\n');
    const result = await resolveDesktopVideoLink(input);
    process.stdout.write(`VIDEO_RESOLVER_SMOKE_OK ${JSON.stringify(result)}\n`);
    if (process.env.CC_VIDEO_RESOLVER_SMOKE_DOWNLOAD === '1' && result.url) {
      const downloaded = await downloadVideoForCopy(result.url, {
        name: result.name,
        direct: true,
      });
      process.stdout.write(`VIDEO_RESOLVER_SMOKE_DOWNLOAD_OK ${JSON.stringify(downloaded)}\n`);
    }
  } catch (error) {
    process.stderr.write(`VIDEO_RESOLVER_SMOKE_FAILED ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
