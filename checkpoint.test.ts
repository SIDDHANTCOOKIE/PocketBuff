import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CheckpointStore } from './checkpoint'

describe('checkpoint store', () => {
  it('atomically saves and restores state', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-state-')), 'state.json')
    const store = new CheckpointStore<{ turn: number }>(file)
    store.save({ turn: 2 })
    expect(store.load()).toEqual({ turn: 2 })
  })
})
