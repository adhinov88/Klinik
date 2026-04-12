CREATE TABLE IF NOT EXISTS queue_counters (
  queue_date DATE PRIMARY KEY,
  last_number INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  nik VARCHAR(32),
  birth_date DATE,
  gender VARCHAR(16),
  phone VARCHAR(32) NOT NULL,
  email TEXT NOT NULL,
  address TEXT,
  complaint TEXT,
  visit_date DATE NOT NULL,
  queue_date DATE NOT NULL,
  queue_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS registrations_queue_date_idx
  ON registrations (queue_date, queue_number);

CREATE INDEX IF NOT EXISTS registrations_visit_date_idx
  ON registrations (visit_date);
