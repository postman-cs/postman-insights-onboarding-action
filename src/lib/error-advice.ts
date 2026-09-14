import type { HttpError } from '@postman-cs/automation-core';
import { toOneLine, type SecretMasker } from './secrets.js';

function safeAdvice(mask: SecretMasker, message: string): string {
  return toOneLine(mask(message));
}

export interface ErrorAdviceContext {
  operation: string;
  hasAccessToken: boolean;
  sessionTeamId?: string;
  sessionRoles?: string[];
  sessionConsumerType?: string;
  workspaceTeamId?: string;
  explicitTeamId?: string;
  mask: SecretMasker;
}

/** Canonical org-mode linking guidance, single-sourced here so the texts cannot diverge. */
export const WORKSPACE_PERSONAL_ONLY_ADVICE =
  'Linking failed: the response reports only personal workspaces can be used outside a team. ' +
  'This may be an org-mode account that requires the postman-team-id input (POSTMAN_TEAM_ID) ' +
  'so the link resolves under the right sub-team.';

function expiryAdvice(code: 'UNAUTHENTICATED' | 'authenticationError'): string {
  return (
    `postman: Bifrost rejected the access token (${code}). ` +
    'Provide a fresh human-user session access token; it cannot be minted from a PMAK. ' +
    'Confirm postman-access-token belongs to the same parent org as postman-api-key and re-run.'
  );
}

function forbiddenAdvice(ctx: ErrorAdviceContext): string {
  const sessionDetail = ctx.sessionTeamId
    ? ` while the access token is valid (it resolved to team ${ctx.sessionTeamId}` +
      `${ctx.sessionRoles && ctx.sessionRoles.length > 0 ? `, roles [${ctx.sessionRoles.join(', ')}]` : ''}` +
      `${ctx.sessionConsumerType ? `, consumerType ${ctx.sessionConsumerType}` : ''} at preflight)`
    : '';
  const scopedTeamId = ctx.workspaceTeamId || ctx.explicitTeamId;
  const teamClause = scopedTeamId
    ? `, or postman-team-id ${scopedTeamId} names a sub-team it cannot act in`
    : ', or the postman-team-id / POSTMAN_TEAM_ID in use names a sub-team it cannot act in';
  return (
    `postman: Bifrost refused ${ctx.operation || 'this operation'} with 403${sessionDetail}. ` +
    `The token's identity lacks permission for this endpoint${teamClause}. ` +
    "Verify the human user's access to the workspace and confirm any postman-team-id / POSTMAN_TEAM_ID override with the workspace administrator. Do not infer the gateway team header from PMAK /me or /teams."
  );
}

function buildAdvice(status: number, body: string, ctx: ErrorAdviceContext): string | undefined {
  if (body.includes('UNAUTHENTICATED')) {
    return expiryAdvice('UNAUTHENTICATED');
  }
  if (body.includes('authenticationError')) {
    return expiryAdvice('authenticationError');
  }
  if (body.includes('Only personal workspaces')) {
    return WORKSPACE_PERSONAL_ONLY_ADVICE;
  }
  if (body.includes('projectAlreadyConnected')) {
    return (
      `postman: ${ctx.operation || 'this operation'} reports projectAlreadyConnected with no workspace id in the error body. ` +
      'The repository is already linked to a workspace this credential cannot see, usually one created by a different credential pair or sub-team. ' +
      'Ask a workspace administrator to identify the existing link and confirm access before changing it, then re-run with credentials for the intended workspace.'
    );
  }
  if (body.includes('invalidParamError') && body.includes('already exists')) {
    return (
      `postman: ${ctx.operation || 'this operation'} hit a duplicate resource error (invalidParamError: already exists). ` +
      'A matching resource already exists, possibly under another credential pair or sub-team where this credential cannot see it. ' +
      'Identify which workspace holds the existing resource and re-run with one credential pair from a single parent org.'
    );
  }
  if (body.includes('Team feature is not available for your organization')) {
    return (
      `postman: ${ctx.operation || 'this operation'} failed because the team feature is not available for this organization. ` +
      'The credential belongs to an account whose plan lacks team features; use credentials from the intended team and confirm the plan supports this operation.'
    );
  }
  if (
    body.includes('You are not authorized to perform this action') ||
    (status === 403 && ctx.hasAccessToken)
  ) {
    return forbiddenAdvice(ctx);
  }
  return undefined;
}

export function adviseFromHttpError(err: HttpError, ctx: ErrorAdviceContext): Error | undefined {
  const body = err.responseBody || err.message || '';
  const advice = buildAdvice(err.status, body, ctx);
  if (!advice) {
    return undefined;
  }
  return new Error(safeAdvice(ctx.mask, advice), { cause: err });
}

export function adviseFromBifrostBody(
  status: number,
  body: string,
  ctx: ErrorAdviceContext
): Error | undefined {
  const advice = buildAdvice(status, String(body || ''), ctx);
  if (!advice) {
    return undefined;
  }
  const safeBody = safeAdvice(ctx.mask, String(body || '')).slice(0, 800);
  return new Error(safeAdvice(ctx.mask, advice), {
    cause: new Error(`HTTP ${status}: ${safeBody}`)
  });
}
