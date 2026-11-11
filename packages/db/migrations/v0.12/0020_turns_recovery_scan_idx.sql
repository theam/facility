CREATE INDEX turns_queued_created_idx ON turns(created_at) WHERE state = 'queued';
CREATE INDEX turns_running_updated_idx ON turns(updated_at) WHERE state = 'running';
