-- Tangent Club: Premium booking core table (step 1)
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,

  guest_user_id TEXT NOT NULL,
  model_user_id TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'in_progress', 'completed', 'expired')),

  -- Money fields are stored in minor units (e.g. cents).
  currency TEXT NOT NULL DEFAULT 'EUR'
    CHECK (length(currency) = 3),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor >= 0),
  platform_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_minor >= 0),
  model_payout_minor INTEGER NOT NULL DEFAULT 0 CHECK (model_payout_minor >= 0),

  -- Escrow/payment lifecycle
  escrow_status TEXT NOT NULL DEFAULT 'not_funded'
    CHECK (escrow_status IN ('not_funded', 'funded', 'released', 'refunded', 'failed')),
  escrow_reference TEXT,

  scheduled_start_at INTEGER NOT NULL,
  scheduled_end_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,

  guest_note TEXT NOT NULL DEFAULT '',
  model_note TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (guest_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (model_user_id) REFERENCES users(id) ON DELETE CASCADE,

  CHECK (scheduled_end_at > scheduled_start_at),
  CHECK (guest_user_id != model_user_id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_guest_user_id ON bookings(guest_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_model_user_id ON bookings(model_user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_escrow_status ON bookings(escrow_status);
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_start ON bookings(scheduled_start_at);
