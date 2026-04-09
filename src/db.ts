import { Kysely } from 'kysely'
import { LibsqlDialect } from '@libsql/kysely-libsql'

interface CheckInRow {
  id?: string // has DEFAULT
  user_id: string
  branch_code: string
  timestamp: string
  note: string
  photo_url: string | null
  created_at?: string // has DEFAULT
}

interface UserProfileRow {
  user_id: string
  name: string
  home_branch: string
  updated_at?: string   // has DEFAULT
}

interface Database {
  check_ins: CheckInRow
  user_profile: UserProfileRow
}

export function createDb(env: { TURSO_DATABASE_URL: string; TURSO_AUTH_TOKEN: string }) {
  return new Kysely<Database>({
    dialect: new LibsqlDialect({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }),
  })
}
