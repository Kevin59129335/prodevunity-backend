CREATE DATABASE IF NOT EXISTS prodevunity;
USE prodevunity;

-- 1. Tabella Utenti (Aggiornata con Email, Verifica e OAuth)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NULL, -- Può essere NULL se l'utente si registra via OAuth Social
    role ENUM('dev', 'client', 'admin') DEFAULT 'dev',
    user_custom_id VARCHAR(20),
    bio VARCHAR(255) DEFAULT 'Developer on ProDevUnity',
    boosted_until BIGINT DEFAULT 0,
    is_email_verified TINYINT(1) DEFAULT 0,
    email_verification_token VARCHAR(255) NULL,
    github_id VARCHAR(100) NULL UNIQUE,
    google_id VARCHAR(100) NULL UNIQUE,
    created_at BIGINT NOT NULL
);

-- 2. Tabella Post / Community Feed
CREATE TABLE IF NOT EXISTS posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    author VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    language VARCHAR(50) DEFAULT 'General',
    description TEXT NOT NULL,
    code TEXT,
    created_at BIGINT NOT NULL
);

-- 3. Tabella Offerte di Lavoro
CREATE TABLE IF NOT EXISTS jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_username VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    budget VARCHAR(50) NOT NULL,
    category VARCHAR(50) DEFAULT 'General',
    description TEXT NOT NULL,
    status ENUM('open', 'closed') DEFAULT 'open',
    created_at BIGINT NOT NULL
);

-- 4. Tabella Candidature Lavoro
CREATE TABLE IF NOT EXISTS job_applications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id INT NOT NULL,
    dev_username VARCHAR(50) NOT NULL,
    proposal_text TEXT NOT NULL,
    status ENUM('pending', 'accepted', 'rejected') DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- 5. Tabella Messaggi Chat
CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    channel VARCHAR(50) NOT NULL,
    sender VARCHAR(50) NOT NULL,
    text TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

-- 6. Tabella Canali Chat
CREATE TABLE IF NOT EXISTS channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    type ENUM('public', 'private') DEFAULT 'public',
    password VARCHAR(255),
    creator VARCHAR(50) NOT NULL,
    created_at BIGINT NOT NULL
);

-- 7. Tabella Recensioni e Feedback Verificati
CREATE TABLE IF NOT EXISTS reviews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id INT NOT NULL,
    reviewer_username VARCHAR(50) NOT NULL,
    reviewed_username VARCHAR(50) NOT NULL,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_username) REFERENCES users(username) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_username) REFERENCES users(username) ON DELETE CASCADE,
    UNIQUE KEY unique_job_review (job_id, reviewer_username)
);