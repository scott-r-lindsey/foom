#!/usr/bin/env python3
"""Rebuild the Electron plan from gh run download directories (stdlib only)."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
# Use the same registration-only technique as electron-shard.test.mjs. Test bodies
# never run; generated names and XML-decoded names are compared exactly.
REGISTRATIONS = r"""
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { suiteFiles } = require('./tests/electron/test-suites.js');
const names = [];
for (const file of suiteFiles()) {
  const suiteRequire = createRequire(file);
  runInNewContext(readFileSync(file, 'utf8'), {
    process,
    require: (specifier) => specifier === './test-shard.js'
      ? { test: (name) => names.push(name) } : suiteRequire(specifier),
  });
}
process.stdout.write(JSON.stringify(names));
"""


def read_measurements(sources, platforms, names, count):
    durations = {name: [None] * len(platforms) for name in names}
    for source in sources:
        if not source.name.isdecimal():
            raise ValueError(f"Source directory must be a numeric Actions run ID: {source}")
        for index, platform in enumerate(platforms):
            reports = sorted(source.glob(f"electron-results-{platform}-*/electron.xml"))
            if len(reports) != count:
                raise ValueError(f"Expected {count} {platform} reports in {source}, got {len(reports)}")
            seen = set()
            for report in reports:
                for case in ET.parse(report).iter('testcase'):
                    # Node emits empty-file placeholders as testcases as well.
                    if not case.get('file', '').replace('\\', '/').endswith('/test-shard.js'):
                        continue
                    name = case.get('name')
                    if name in seen:
                        raise ValueError(f"Duplicate case {name!r} in {source} ({platform})")
                    seen.add(name)
                    seconds = float(case.attrib['time'])
                    if not math.isfinite(seconds) or seconds < 0:
                        raise ValueError(f"Invalid duration for {name!r} in {report}")
                    if case.find('failure') is not None or case.find('error') is not None:
                        raise ValueError(f"Failed case {name!r} in {report}; use green runs")
                    if name not in durations:
                        continue  # Removed/renamed cases from older sources.
                    seconds = 0 if case.find('skipped') is not None else round(seconds, 3)
                    previous = durations[name][index]
                    durations[name][index] = max(previous or 0, seconds)
    missing = [f"{name} ({platforms[i]})" for name, values in durations.items()
               for i, value in enumerate(values) if value is None]
    if missing:
        raise ValueError("Current cases missing measurements: " + ', '.join(missing))
    return durations


def balance(durations, count):
    totals = [sum(values[i] for values in durations.values()) for i in range(3)]
    if any(total <= 0 for total in totals):
        raise ValueError('Every platform must have a positive measured total')
    fractions = {name: [value / total for value, total in zip(values, totals)]
                 for name, values in durations.items()}
    loads = [[0.0] * 3 for _ in range(count)]
    shards = [{} for _ in range(count)]
    for name in sorted(durations, key=lambda name: (-max(fractions[name]), name)):
        weights = fractions[name]

        def score(index):
            projected = [[value + (weights[p] if shard == index else 0)
                          for p, value in enumerate(load)]
                         for shard, load in enumerate(loads)]
            return max(map(max, projected)), sum(projected[index]), index

        selected = min(range(count), key=score)
        shards[selected][name] = durations[name]
        loads[selected] = [a + b for a, b in zip(loads[selected], weights)]
    return [dict(sorted(shard.items())) for shard in shards]


def projected_totals(shards, durations):
    assignments = {name: index for index, shard in enumerate(shards) for name in shard}
    loads = [[0.0] * 3 for _ in shards]
    for name, values in durations.items():
        selected = assignments.get(name)
        if selected is None:
            selected = int.from_bytes(hashlib.sha256(name.encode()).digest()[:4], 'big') % len(shards)
        loads[selected] = [a + b for a, b in zip(loads[selected], values)]
    return [[round(load[i], 1) for load in loads] for i in range(3)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sources', nargs='+', type=Path, help='Downloaded run directories named by run ID')
    parser.add_argument('--write', action='store_true', help='Replace the plan; otherwise only print projections')
    args = parser.parse_args()
    plan_path = ROOT / 'tests/electron/shard-plan.json'
    old = json.loads(plan_path.read_text())
    names = json.loads(subprocess.check_output(['node', '-e', REGISTRATIONS], cwd=ROOT, text=True))
    if len(set(names)) != len(names):
        raise ValueError('Duplicate current test registration')
    sources = sorted(set(source.resolve() for source in args.sources))
    durations = read_measurements(sources, old['platforms'], names, len(old['shards']))
    shards = balance(durations, len(old['shards']))
    print(f'{len(names)} current cases; per-platform maxima across {len(sources)} runs (seconds)')
    for label, assignments in [('Before (including hash fallback)', old['shards']), ('After', shards)]:
        print(label)
        for platform, totals in zip(old['platforms'], projected_totals(assignments, durations)):
            print(f'  {platform}: {" / ".join(map(str, totals))}')
    if args.write:
        plan = {'sourceRuns': [int(source.name) for source in sources],
                'platforms': old['platforms'], 'shards': shards}
        plan_path.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + '\n')
        print('Wrote tests/electron/shard-plan.json; run pnpm run format')


if __name__ == '__main__':
    main()
