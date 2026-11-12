const {execFileSync} = require('node:child_process');
function needsBuild(files) {
  return files.some(file =>
    (file.startsWith('web/') && file !== 'web/inventory.json' && !file.startsWith('web/photos/')) ||
    file.startsWith('api/') || ['vercel.json', '.vercelignore', 'package.json', 'package-lock.json',
      'scripts/build_site.cjs', 'scripts/ignore_vercel_build.cjs'].includes(file));
}
function shouldSkip(env = process.env) {
  if (env.VERCEL_GIT_COMMIT_REF === 'raptor-finder') return true;
  // Compare with the last successful deployment, not just HEAD's parent, so
  // collector commits cannot hide pending application changes.
  const previous = env.VERCEL_GIT_PREVIOUS_SHA;
  if (!previous || !/^[a-f0-9]{40}$/.test(previous)) return false;
  // Redeploying the same commit must apply updated secrets and settings.
  if (previous === env.VERCEL_GIT_COMMIT_SHA) return false;
  try {
    const changed = execFileSync('git', ['diff', '--name-only', previous, 'HEAD'], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
    return !needsBuild(changed);
  } catch { return false; } // Missing shallow history: build rather than miss a release.
}
if (require.main === module) {
  const skip = shouldSkip();
  console.log(skip ? 'Skipping Vercel: no application changes.' : 'Building application changes.');
  process.exit(skip ? 0 : 1);
}
module.exports = {needsBuild, shouldSkip};
