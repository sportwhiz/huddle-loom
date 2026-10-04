-- Generated from Better Auth 1.7.7 and passkey 1.7.7; review before changing.
create table "auth_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "twoFactorEnabled" integer);

create table "auth_sessions" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_users" ("id") on delete cascade, "absoluteExpiresAt" date not null, "authenticatedAt" date not null, "assurance" text not null, "authVersion" integer not null);

create table "auth_accounts" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_users" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "auth_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "auth_two_factors" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "auth_users" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);

create table "auth_passkeys" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "auth_users" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);

create index "auth_sessions_userId_idx" on "auth_sessions" ("userId");

create index "auth_accounts_userId_idx" on "auth_accounts" ("userId");

create index "auth_verifications_identifier_idx" on "auth_verifications" ("identifier");

create index "auth_two_factors_secret_idx" on "auth_two_factors" ("secret");

create index "auth_two_factors_userId_idx" on "auth_two_factors" ("userId");

create index "auth_passkeys_userId_idx" on "auth_passkeys" ("userId");

create index "auth_passkeys_credentialID_idx" on "auth_passkeys" ("credentialID");
