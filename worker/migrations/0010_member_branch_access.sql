-- Keep current staff working as before; owners can narrow each account in Settings.
ALTER TABLE members ADD COLUMN branch_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE invites ADD COLUMN branch_ids TEXT NOT NULL DEFAULT '[]';

UPDATE members
SET branch_ids = COALESCE((
  SELECT json_group_array(id) FROM branches WHERE branches.pharmacy_id = members.pharmacy_id
), '[]')
WHERE role NOT IN ('owner', 'partner');

UPDATE invites
SET branch_ids = COALESCE((
  SELECT json_group_array(id) FROM branches WHERE branches.pharmacy_id = invites.pharmacy_id
), '[]')
WHERE role NOT IN ('partner');
