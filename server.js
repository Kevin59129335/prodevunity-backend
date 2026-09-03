// ==========================================
// 7. JOBS BOARD & APPLICATIONS (/api/jobs)
// ==========================================

// Get jobs based on role
app.get('/api/jobs', authenticateToken, async (req, res) => {
    try {
        if (req.user.role === 'client') {
            // Clients see their own jobs + application count
            const [jobs] = await db.query(`
                SELECT j.*, COUNT(a.id) as app_count
                FROM jobs j
                LEFT JOIN job_applications a ON j.id = a.job_id
                WHERE j.client_username = ?
                GROUP BY j.id
                ORDER BY j.created_at DESC
            `, [req.user.username]);
            res.json({ ok: true, jobs });
        } else {
            // Devs see open jobs + their own application status (pending, rejected, etc.)
            const [jobs] = await db.query(`
                SELECT j.*,
                       (SELECT status FROM job_applications WHERE job_id = j.id AND dev_username = ?) as my_application_status
                FROM jobs j
                WHERE j.status = 'open'
                ORDER BY j.created_at DESC
            `, [req.user.username]);
            res.json({ ok: true, jobs });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Post a new job (Clients only)
app.post('/api/jobs', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Only clients can post jobs.' });
    const { title, budget, category, description } = req.body;
    try {
        await db.query(
            'INSERT INTO jobs (client_username, title, budget, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.username, title, budget, category || 'General', description, Date.now()]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Apply to a job (Devs only)
app.post('/api/jobs/:id/apply', authenticateToken, async (req, res) => {
    if (req.user.role !== 'dev') return res.status(403).json({ error: 'Only developers can apply for jobs.' });
    const { proposal_text } = req.body;
    try {
        const [existing] = await db.query('SELECT id FROM job_applications WHERE job_id = ? AND dev_username = ?', [req.params.id, req.user.username]);
        if (existing.length > 0) return res.status(400).json({ error: 'You have already applied to this job.' });
        
        await db.query(
            'INSERT INTO job_applications (job_id, dev_username, proposal_text, created_at) VALUES (?, ?, ?, ?)',
            [req.params.id, req.user.username, proposal_text, Date.now()]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get applications for a specific job (Clients only)
app.get('/api/jobs/:id/applications', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Only clients can view applications.' });
    try {
        const [jobs] = await db.query('SELECT id FROM jobs WHERE id = ? AND client_username = ?', [req.params.id, req.user.username]);
        if (jobs.length === 0) return res.status(403).json({ error: 'Not your job or job not found.' });

        const [apps] = await db.query('SELECT * FROM job_applications WHERE job_id = ? ORDER BY created_at ASC', [req.params.id]);
        res.json({ ok: true, apps });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Accept or Reject an application (Clients only)
app.put('/api/applications/:id/status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'Only clients can change status.' });
    const { status } = req.body; // 'accepted' or 'rejected'
    const appId = req.params.id;
    try {
        // Verify ownership
        const [apps] = await db.query('SELECT job_id FROM job_applications WHERE id = ?', [appId]);
        if (apps.length === 0) return res.status(404).json({ error: 'Application not found.' });
        const jobId = apps[0].job_id;

        const [jobs] = await db.query('SELECT id FROM jobs WHERE id = ? AND client_username = ?', [jobId, req.user.username]);
        if (jobs.length === 0) return res.status(403).json({ error: 'Not your job.' });

        // Update target application status
        await db.query('UPDATE job_applications SET status = ? WHERE id = ?', [status, appId]);
        
        if (status === 'accepted') {
            // Close job to hide from devs feeds
            await db.query("UPDATE jobs SET status = 'closed' WHERE id = ?", [jobId]);
            // Reject all other pending applications for this job
            await db.query("UPDATE job_applications SET status = 'rejected' WHERE job_id = ? AND id != ?", [jobId, appId]);
        }

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
