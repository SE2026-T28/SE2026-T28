// Injectable commands let regression tests exercise failures without a Docker daemon.
export function ownedDocker(command, runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid harness run ID');
  const name = `app04-s3-${runId}`;
  const label = `app04.s3.run=${runId}`;
  function inspect(id) {
    const info = JSON.parse(command('docker', ['inspect', id]))[0];
    if (info.Id !== id || info.Name !== `/${name}`
      || info.Config?.Labels?.['app04.s3.run'] !== runId
      || info.Config.Image !== 'postgres:17.11') throw new Error('Container ownership mismatch');
    return info;
  }
  return {
    start(args) {
      const id = command('docker', ['run', '--detach', '--rm', '--name', name, '--label', label, ...args]);
      return inspect(id);
    },
    cleanup() {
      // Discover even if run threw before returning its ID. Never prune globally.
      const ids = command('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${label}`])
        .split(/\s+/).filter(Boolean);
      const failures = [];
      for (const id of ids) {
        try {
          if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid container ID');
          inspect(id); // recheck exact name, label, image and ID immediately before removal
          command('docker', ['rm', '--force', id]);
        } catch { failures.push('owned container removal'); }
      }
      if (failures.length) throw new Error('Owned Docker cleanup incomplete');
    },
  };
}

// Errors are reported only after every step has been attempted. Keep diagnostics
// to fixed step names: command errors may contain credentials or connection URLs.
export async function cleanupSteps(steps) {
  const failures = [];
  for (const [name, action] of steps) {
    try { await action(); } catch { failures.push(name); }
  }
  return failures;
}
