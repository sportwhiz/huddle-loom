export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

export type Principal = {
  id: string;
  email: string;
  localUsername?: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  issuer: string;
  subject: string;
  sessionId: string;
  expiresAt: string | null;
  authentication: 'cloudflare-access' | 'local-development' | 'oauth' | 'native' | 'guest';
  authVersion?: number;
  assurance?: 'weak' | 'strong' | 'recovery';
  authenticatedAt?: string;
  grantId?: string;
  resourceMode?: 'all' | 'selected';
  resources?: { type: 'board' | 'workbook'; id: string }[];
  scopes?: string[];
};

export type Capabilities = {
  role: Role;
  read: true;
  edit: boolean;
  comment: boolean;
  facilitate: boolean;
  share: boolean;
  manage: boolean;
  export: boolean;
};

export type Collaborator = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  role: Role;
  source: 'direct' | 'invitation' | 'migration' | 'workbook';
  expiresAt: string | null;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
};

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

export function roleAtLeast(actual: Role, required: Role) {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function capabilitiesForRole(role: Role): Capabilities {
  return {
    role,
    read: true,
    edit: roleAtLeast(role, 'editor'),
    comment: roleAtLeast(role, 'commenter'),
    facilitate: roleAtLeast(role, 'editor'),
    share: role === 'owner',
    manage: role === 'owner',
    export: roleAtLeast(role, 'editor'),
  };
}

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'editor' || value === 'commenter' || value === 'viewer';
}
