module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolved-imports',
      severity: 'error',
      from: { path: '^src/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'engine-is-independent-of-ui',
      severity: 'error',
      from: { path: '^src/(core|providers|config|shared|tools|security)/' },
      to: { path: '^src/(cli|ui)/|node_modules/(react|ink)/' },
    },
    {
      name: 'shared-is-a-leaf',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/', pathNot: '^src/shared/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
    },
  },
};
