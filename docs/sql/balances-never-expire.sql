-- OPTIONAL hardening. Purchased balances never expire.
-- The application no longer calls expire_paid_tokens / expire_all_paid_tokens, and
-- complete_token_purchase does not set paid_tokens_expires_at, so nothing expires today
-- (checked on the production project: 0 users have an expiry date).
-- Run this only if you also want the database itself to guarantee it, e.g. in case an
-- old script or a manual call invokes the legacy sweep. Both functions become no-ops
-- with the same signatures; any stored expiry date is cleared.
create or replace function public.expire_paid_tokens(p_user_id uuid)
returns bigint language sql as $$ select 0::bigint $$;

create or replace function public.expire_all_paid_tokens()
returns integer language sql as $$ select 0 $$;

update public.users set paid_tokens_expires_at = null where paid_tokens_expires_at is not null;
