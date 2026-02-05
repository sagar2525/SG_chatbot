const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');

// Production Webhook URL only
const WEBHOOK_URL = 'https://n8n.smallgrp.com/webhook/af2cb6fe-6c94-45b2-af8e-5214cb72d7c8';

// Trust proxy for getting real IP behind reverse proxies (Vercel, etc.)
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files from current directory

// Helper function to get client IP
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.headers['x-real-ip'] || 
           req.socket?.remoteAddress || 
           req.ip || 
           'unknown';
}

// Helper function to create session ID from IP
function createSessionId(ip) {
    const hash = crypto.createHash('md5').update(ip + Date.now().toString()).digest('hex').substring(0, 8);
    return `sg_${hash}_${Date.now()}`;
}

// Endpoint to get/create session based on user IP
app.get('/api/session', (req, res) => {
    const clientIP = getClientIP(req);
    const sessionId = createSessionId(clientIP);
    
    res.json({
        sessionId: sessionId,
        ip: clientIP,
        timestamp: new Date().toISOString()
    });
});

// Endpoint for webcall - triggers webhook with webcall header
app.post('/api/webcall', async (req, res) => {
    const { sessionId } = req.body;
    const clientIP = getClientIP(req);
    const timestamp = new Date().toISOString();
    
    console.log(`[${timestamp}] Webcall triggered from IP: ${clientIP}`);
    
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Request-Type': 'webcall'
            },
            body: JSON.stringify({
                type: 'webcall',
                sessionId: sessionId || createSessionId(clientIP),
                clientIP: clientIP,
                timestamp: timestamp
            })
        });
        
        if (!response.ok) {
            console.error(`Webcall webhook error: ${response.status}`);
            return res.status(response.status).json({ error: 'Webhook error' });
        }
        
        const data = await response.text();
        res.json({ success: true, message: 'Webcall triggered', data });
        
    } catch (error) {
        console.error('Webcall error:', error);
        res.status(500).json({ error: 'Failed to trigger webcall' });
    }
});

app.post('/api/chat', async (req, res) => {
    const { message, sessionId } = req.body;
    const startTime = new Date().toISOString();
    const clientIP = getClientIP(req);

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    // Generate unique ID based on IP if not provided
    const uniqueId = sessionId || createSessionId(clientIP);

    console.log(`[${startTime}] Sending to production: ${message.substring(0, 50)}...`);

    try {
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: message,
                sessionId: uniqueId,
                timestamp: startTime
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Webhook responded with ${response.status}: ${response.statusText}`);
            console.error(`Error details: ${errorText}`);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.write(`Sorry, the webhook returned an error (${response.status}). Please try again later.`);
            res.end();
            saveHistory(message, `Error: ${response.status}`, startTime, uniqueId);
            return;
        }

        const contentType = response.headers.get('content-type');

        // Check if response is streaming or JSON
        if (contentType && contentType.includes('application/json')) {
            // Handle JSON response
            const data = await response.json();
            let botResponse = '';

            if (typeof data === 'string') {
                botResponse = data;
            } else if (data.message) {
                botResponse = data.message;
            } else if (data.response) {
                botResponse = data.response;
            } else if (data.text) {
                botResponse = data.text;
            } else if (data.output) {
                botResponse = data.output;
            } else if (Array.isArray(data) && data.length > 0) {
                botResponse = data.map(item => {
                    if (typeof item === 'string') return item;
                    return item.message || item.response || item.text || JSON.stringify(item);
                }).join('\n\n');
            } else {
                botResponse = JSON.stringify(data);
            }

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.write(botResponse);
            res.end();
            saveHistory(message, botResponse, startTime, uniqueId);

        } else {
            // Handle streaming response
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Transfer-Encoding', 'chunked');

            let fullResponse = '';
            let buffer = '';

            for await (const chunk of response.body) {
                const text = Buffer.from(chunk).toString('utf8');
                buffer += text;

                // Try to parse as JSON lines (n8n streaming format)
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep the last partial line

                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const json = JSON.parse(line);
                            if (json.type === 'item' && json.content) {
                                res.write(json.content);
                                fullResponse += json.content;
                            } else if (json.message || json.text || json.response) {
                                const content = json.message || json.text || json.response;
                                res.write(content);
                                fullResponse += content;
                            }
                        } catch (e) {
                            // Not JSON, just write as-is
                            res.write(line);
                            fullResponse += line;
                        }
                    }
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                try {
                    const json = JSON.parse(buffer);
                    if (json.type === 'item' && json.content) {
                        res.write(json.content);
                        fullResponse += json.content;
                    } else if (json.message || json.text || json.response) {
                        const content = json.message || json.text || json.response;
                        res.write(content);
                        fullResponse += content;
                    }
                } catch (e) {
                    // Not JSON, write as-is
                    res.write(buffer);
                    fullResponse += buffer;
                }
            }

            res.end();
            saveHistory(message, fullResponse, startTime, uniqueId);
        }

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});

function saveHistory(userMessage, botResponse, timestamp, sessionId) {
    fs.readFile(HISTORY_FILE, 'utf8', (err, data) => {
        let history = [];
        if (!err && data) {
            try {
                history = JSON.parse(data);
            } catch (e) {
                console.error('Error parsing history file:', e);
            }
        }

        history.push({
            timestamp,
            sessionId,
            userMessage,
            botResponse,
            savedAt: new Date().toISOString()
        });

        fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), (err) => {
            if (err) console.error('Error saving history:', err);
            else console.log('History saved successfully');
        });
    });
}

app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📁 Open http://localhost:${PORT}/chatbot.html to use the chatbot`);
});
