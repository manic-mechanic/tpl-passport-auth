import { Kysely } from 'kysely'
import { LibsqlDialect } from '@libsql/kysely-libsql'

interface CheckInRow {
  id: string
  user_id: string
  branch_code: string
  timestamp: string
  note: string
  photo_url: string | null
  created_at: string
}

interface Database {
  check_ins: CheckInRow
}

export function createDb(env: { TURSO_DATABASE_URL: string; TURSO_AUTH_TOKEN: string }) {
  return new Kysely<Database>({
    dialect: new LibsqlDialect({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }),
  })
}
