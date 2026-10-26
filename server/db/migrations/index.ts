// 迁移文件清单：按 version 升序执行，只追加、不改已执行过的 SQL。
// 迁移 SQL 以 TS 模块内联，保证随 Nitro 构建产物一起发布（设计 §10：不能靠开发目录的 SQL 文件运行生产服务）。
import type { Migration } from '../types'
import { migration as m001 } from './001-init'
import { migration as m002 } from './002-library'
import { migration as m003 } from './003-job-output'
import { migration as m004 } from './004-question-bank'

export const migrations: Migration[] = [m001, m002, m003, m004]
