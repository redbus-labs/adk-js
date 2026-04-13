import {execSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';

const REGISTRY = process.env.CUSTOM_REGISTRY_URL;
const NEW_NAMESPACE = process.env.CUSTOM_NAMESPACE || '@google';

const args = process.argv.slice(2);
const isCoreOnly = args.includes('--core-only');
const isAll = args.includes('--all');

if (!isCoreOnly && !isAll) {
  console.error(
    'Error: Please specify publishing scope with --core-only or --all',
  );
  process.exit(1);
}

const packagesToPublish = [
  {
    path: 'core/package.json',
    dir: 'core',
    oldName: '@google/adk',
    newName: `${NEW_NAMESPACE}/adk`,
  },
];

if (isAll) {
  packagesToPublish.push({
    path: 'dev/package.json',
    dir: 'dev',
    oldName: '@google/adk-devtools',
    newName: `${NEW_NAMESPACE}/adk-devtools`,
  });
}

// 1. Preflight checks
console.log('--- Preflight Checks ---');
for (const pkg of packagesToPublish) {
  const content = readFileSync(pkg.path, 'utf-8');
  if (!content.includes(`"name": "${pkg.oldName}"`)) {
    console.error(
      `Error: Could not find "name": "${pkg.oldName}" in ${pkg.path}`,
    );
    process.exit(1);
  }
}

// Check npmrc or token conceptually (we just assume they configured it per docs)
console.log(`Registry target: ${REGISTRY}`);
console.log(
  'Publishing scope:',
  packagesToPublish.map((p) => p.newName).join(', '),
);
console.log('------------------------\n');

// Store original contents for safe rollback
const originalContents = new Map();

try {
  // 2. Safe mutation strategy
  for (const pkg of packagesToPublish) {
    const content = readFileSync(pkg.path, 'utf-8');
    originalContents.set(pkg.path, content);

    const newContent = content.replace(
      `"name": "${pkg.oldName}"`,
      `"name": "${pkg.newName}"`,
    );
    writeFileSync(pkg.path, newContent, 'utf-8');
    console.log(
      `✅ Temporarily renamed ${pkg.oldName} to ${pkg.newName} in ${pkg.path}`,
    );
  }

  // 3. Efficient build & publish flow
  console.log('\n--- Building ---');
  execSync('npm run build', {stdio: 'inherit'});

  console.log('\n--- Publishing ---');
  for (const pkg of packagesToPublish) {
    console.log(`Publishing ${pkg.newName} to ${REGISTRY}...`);
    execSync(`npm publish --registry=${REGISTRY}`, {
      cwd: pkg.dir,
      stdio: 'inherit',
    });
  }

  console.log('\n🎉 Successfully published!');
} catch (error) {
  console.error('\n❌ Error during publish process:', error.message);
  process.exitCode = 1;
} finally {
  // 4. Guaranteed rollback
  console.log('\n--- Rollback ---');
  for (const [filePath, content] of originalContents.entries()) {
    writeFileSync(filePath, content, 'utf-8');
    console.log(`✅ Restored original content of ${filePath}`);
  }
}
