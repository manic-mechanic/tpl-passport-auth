export const ALLOWED_ORIGINS = [
  "https://librarypassport.ca",
  "https://www.librarypassport.ca",
  "tplpassportrn://",
  "https://dev.librarypassport.ca",
]

// betterAuth trustedOrigins also needs expo dev client schemes
export const TRUSTED_ORIGINS = [
  ...ALLOWED_ORIGINS,
  "exp://",
  "exp://**",
]
