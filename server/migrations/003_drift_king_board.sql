-- Drift King ranked board. Immutable once scores exist: changed scoring rules need a new board id.
-- One definition backs both rankings: all-time best rows use board_id 'drift-v1', daily best rows
-- use 'drift-v1@YYYY-MM-DD' (UTC day of the server-issued run).
INSERT INTO game_lb_boards
(namespace,id,rules_version,direction,min_score,max_score,min_duration_ms,max_duration_ms,`open`)
VALUES
('production','drift-v1','v1','desc',0,1500000,58500,1800000,TRUE)
ON DUPLICATE KEY UPDATE id=id;
-- Run statistics reported with each submission, kept for audit of the plausibility checks.
ALTER TABLE game_lb_runs
 ADD COLUMN stats_json VARCHAR(512) NULL;
