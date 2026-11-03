-- Registration control from the Admin Portal: automatic opening/closing times, the message shown while closed,
-- and who last changed the status. Additive only: existing editions keep registration_open as it is, and
-- school_registrations is not touched.

ALTER TABLE competition_editions
  ADD COLUMN registration_opens_at          timestamptz,
  ADD COLUMN registration_closes_at         timestamptz,
  ADD COLUMN registration_closed_message    text CHECK (registration_closed_message IS NULL OR length(registration_closed_message) BETWEEN 1 AND 1000),
  ADD COLUMN registration_status_changed_at timestamptz,
  ADD COLUMN registration_status_changed_by uuid REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE competition_editions ADD CONSTRAINT competition_editions_registration_window
  CHECK (registration_opens_at IS NULL OR registration_closes_at IS NULL OR registration_closes_at > registration_opens_at);
