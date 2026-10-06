import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<
    string,
    { version?: string; license?: string; dev?: boolean; devOptional?: boolean }
  >;
};
const groups = new Map<string, { text: string; packages: string[] }>();
const rows: string[] = [];
const sources = JSON.parse(
  await readFile(join(root, 'docs/licenses/sources.json'), 'utf8'),
) as Record<string, { version: string; file: string; source: string; sha256: string }>;
for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b, 'en'),
)) {
  if (!location || entry.dev || entry.devOptional) continue;
  assert(
    /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(location) &&
      !location.split('/').includes('..'),
    'Invalid package path',
  );
  const directory = join(root, location);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
  };
  assert.equal(pkg.version, entry.version, 'Installed dependency differs from lockfile');
  const files = (await readdir(directory))
    .filter((name) =>
      /^(?:licen[sc]e(?:[-_.].*)?|copying(?:[-_.].*)?|notice(?:[-_.].*)?)$/i.test(name),
    )
    .sort();
  let noticeDirectory = directory;
  const origin = sources[pkg.name];
  if (!files.length && origin) {
    assert.equal(origin.version, pkg.version, 'Upstream license needs version review');
    assert(/^[a-z0-9-]+-LICENSE\.txt$/.test(origin.file), 'Invalid license source file');
    noticeDirectory = join(root, 'docs/licenses');
    files.push(origin.file);
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(noticeDirectory, origin.file)))
        .digest('hex'),
      origin.sha256,
      'Upstream notice hash changed',
    );
  }
  assert(files.length, `Missing license text for ${pkg.name}`);
  const references = [];
  for (const file of files) {
    const source = await readFile(join(noticeDirectory, file), 'utf8');
    assert(
      !source.includes('\u0000') && Buffer.byteLength(source) <= 256 * 1024,
      'Invalid license text',
    );
    const text = source.replace(/\r\n/g, '\n').trim();
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const group = groups.get(digest) ?? { text, packages: [] };
    group.packages.push(
      `${pkg.name}@${pkg.version} (${file}${noticeDirectory !== directory ? `; upstream ${origin!.source}; SHA256 ${origin!.sha256}` : ''})`,
    );
    groups.set(digest, group);
    references.push(digest);
  }
  rows.push(
    `| ${pkg.name} | ${pkg.version} | ${entry.license ?? pkg.license ?? 'UNKNOWN'} | ${references.join(', ')} |`,
  );
}
const output =
  '# Third-party runtime dependency notices\n\nGenerated from package-lock.json and installed package license files. Includes locked production dependencies, including transitives. Development-only tools are excluded. License identifiers are upstream metadata; full notices follow. This inventory does not replace reviewing license obligations.\n\n| Package | Locked version | Declared license | Notice IDs |\n| --- | --- | --- | --- |\n' +
  rows.join('\n') +
  '\n\n' +
  [...groups]
    .map(
      ([digest, value]) =>
        `## ${digest}\n\n${value.packages.join('; ')}\n\n\`\`\`text\n${value.text}\n\`\`\`\n`,
    )
    .join('\n');
const target = join(root, 'THIRD_PARTY_NOTICES.md');
if (process.argv.includes('--check'))
  assert.equal(await readFile(target, 'utf8'), output, 'Regenerate notices with npm run licenses');
else await writeFile(target, output, 'utf8');
process.stdout.write(
  JSON.stringify({
    packages: rows.length,
    distinctNotices: groups.size,
    bytes: Buffer.byteLength(output),
    checked: process.argv.includes('--check'),
  }) + '\n',
);
