import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import xss from 'xss';
import log4js from 'log4js';

import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import pkg from 'pg';
import ampqlib from 'amqplib';
import redis from 'redis';
import connectRedis from 'connect-redis';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RedisStore = connectRedis(session);

// Disclaimer: since this was a little test speedrun project, it doesn't have as much documentation
// as I'd personally prefer to see in a real world multi-people project (or even for my own reference)
// although it is all pretty self-contained and he function names mostly clarify what you might expect their
// "contents" to do.


const SERVICE_NAME = 'sender';
const APP_PORT = 8080;

const {
    SESSION_SECRET,
    SESSIONSTORE,
    DBUSER,
    DBPASS,
    DATABASE,
    DBHOST,
    QUEUENAME,
    QUEUEURL
} = process.env;


const INSTANCE_COLORS = ['#6666ff','#66b266','#ffc966','#ff6666','#b266b2','#26acff','#31e8ee', '#c1e06c', '#f49c4c', '#f787ce'];

// in the real world this config could have been also provided through the environment variables
log4js.configure({
    appenders: { out: { type: "stdout", layout: { type: "basic" } } },
    categories: { default: { appenders: ["out"], level: "trace" } },
});
const logger = log4js.getLogger();

const app = express();
const pgPool = new Pool({
    user: DBUSER,
    password: DBPASS,
    database: DATABASE,
    host: DBHOST
});

app.use(express.static(__dirname + '/html'));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    logger.debug("Incoming %s request to %s", req.method, req.url);
    next();
});

const sleep = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

const rabbitConnect = async () => {
     while (true) {
        try {
            logger.debug("Trying to connect to rabbitmq...");
            const messageConn = await ampqlib.connect(QUEUEURL);
            const channel = await messageConn.createChannel();
            await channel.assertQueue(QUEUENAME, {durable: true});
            
            logger.debug("Connection to rabbitmq success!");
            return { messageConn, channel };

        } catch (e) {
            logger.warn("Failed to connect to rabbitmq. Retrying in 1000 ms...")
            logger.warn(e);
            await sleep(1000);
        }
    }
};

const redisConnect = () => {
    return new Promise((resolve) => {
        let initialConnect = true;

        const redisClient = redis.createClient({ 
            legacyMode: true,
            url: `redis://${SESSIONSTORE}:6379` // in the real world: we could/should have made the port here settable too
        });
    
        logger.debug("Trying to connect to redis...");
    
        redisClient.on('connect', () => {
            if (initialConnect) {
                initialConnect = false;
                logger.debug("Connection to redis success!");
                resolve(redisClient);
            }
        });
    
        redisClient.on('error', (err) => {
            logger.warn("Redis error encountered");
            logger.warn(err);
        });

        redisClient.on('reconnecting', (err) => {
            logger.debug("Redis client reconnecting...")
        });

        redisClient.on('ready', (err) => {
            logger.debug("Redis client ready")
        });

        redisClient.on('end', (err) => {
            logger.debug("Redis client disconnected")
        });
        redisClient.connect();
    });
};

// prerequisite connections must establish themselves successfully
const [{ _, channel }, redisClient] = await Promise.all([rabbitConnect(), redisConnect()])


app.use(session({
    secret: SESSION_SECRET,
    store: new RedisStore({ client: redisClient }),
    saveUninitialized: true,
    resave: false,
    cookie: {
        maxAge: 60000
    }
}));


// just a tool to see some interesting info
const randomNum = Math.random();
const INSTANCE_COLOR = INSTANCE_COLORS[Math.floor(randomNum * (INSTANCE_COLORS.length - 1))];
const INSTANCE_NAME = `${SERVICE_NAME}-${Math.floor(randomNum * 2147483647).toString(16)}`


let receivedMessages = 0;
let lastMessageAt = null;


////////////////////////////////////////////////////////////////
//                      MAIN CODE
////////////////////////////////////////////////////////////////


const getExistingMessages = async () => {
    const result = await pgPool.query("SELECT id, timestamp, processed_by, processed_by_color, message FROM SentMessages ORDER BY timestamp DESC LIMIT 20");

    return result?.rows;
};

const handleNewMessage = async (message, req) => {
    try {
        const now = new Date();

        const result = await pgPool.query(
            "INSERT INTO SentMessages(timestamp, processed_by, processed_by_color, message) VALUES ($1, $2, $3, $4)",
            [now.getTime(), INSTANCE_NAME, INSTANCE_COLOR, message]);

        receivedMessages++;
        lastMessageAt = now;

        req.session.messages = (req.session.messages || 0) + 1; // increment session counter

        // we should also immediately alert
        channel.sendToQueue(QUEUENAME, Buffer.from(message), { persistent: true });
    } catch (e) {
        logger.error("Failed to handle new message due to error %s", e.message);
        logger.error(e);
    }
};

const buildHome = async (req, res) => {
    try {
        const rows = await getExistingMessages();
        const tableContents = generateRowsHtml(rows);

        const activeSessionCount = (await redisClient.v4.keys("sess:*"))?.length || 0; // this too is not particularly a great query to do in a real-world production environment!
    
        const fileContents = fs.readFileSync(__dirname + '/html/home.html', 'utf8');// since I'm adding clarifications anyway: reading entire files into memory instead of working 
        // with a buffer & streaming to clients: also not great in the real world!

        if (fileContents) {
            
            // since I decided to share this code publically: this would clearly result in multiple loops/string modifications 
            // and is not very optimal, not easy to understand. In the real world I might've replaced this with something like pug.js
            // or similar. But for this experiment project I figured this is ok

            res.send(fileContents.replace('${PLACEHOLDER}', tableContents)
                .replace('${FOR_NODE}', receivedMessages)
                .replace('${FOR_NODE_LAST}', lastMessageAt ? lastMessageAt.toUTCString() : 'Never')
                .replace('${MESSAGES_SENT_TOTAL}', req.session.messages || 0)
                .replace('${NODE_NAME}', INSTANCE_NAME)
                .replace('${SESSION_COUNT}', activeSessionCount)
                .replaceAll('${NODE_COLOR}', INSTANCE_COLOR)
            );
            
        } else {
            logger.error("Failed to build page as home.html template was empty");
            res.sendStatus(500);
        }
    } catch (e) {
        logger.error("Failed to build page due to exception: %s", e.message);
        logger.error(e);
        res.sendStatus(500);
    }
};

const generateRowsHtml = (rows) => {
    let result = `<table class="table">
        <thead>
        <tr>
        <th scope="col">#</th>
        <th scope="col">Processed By</th>
        <th scope="col">Time</th>
        <th scope="col">Submission</th>
        </tr>
    </thead>`; // and this too is not the best way to build templates: a templating lib would've been preferable in the real world!


    if (!rows || !rows.length) {
        result += `</table> <p>No messages sent yet</p>`
        return result;
    }

    result += '<tbody>';

    rows.forEach(row => {
        result += `<tr>
            <th scope="row">${row.id}</th>
            <td><span class="badge rounded-pill" style="background-color: ${row.processed_by_color} !important;">${row.processed_by}</span></td>
            <td>${new Date(parseInt(row.timestamp)).toUTCString()}</td>
            <td>${xss(row.message)}</td>
        </tr>
        `;
    });

    result += '</tbody></table>';

    return result;
};

app.get('/', async (req, res) => {
    logger.debug("Incoming GET request");
    buildHome(req, res);
});

app.post('/', async (req, res) => {
    logger.debug("Incoming POST request");

    const msg = req.body?.message?.trim();

    if (msg) {
        logger.debug("POST request received with message '%s'", msg);
        await handleNewMessage(msg, req);
    } else {
        logger.warn("POST rquest did not contain message");
    }

    buildHome(req, res);
});

app.get('/reset-session', (req, res, next) => {
    req.session.messages = null;
    req.session.save((err) => {
        if (err) next(err);

        req.session.regenerate((err) => {
            if (err) next(err);
            res.redirect('/');
        });
    });
});


// initiating db
logger.debug(`Initiating sender DB...`);
pgPool.query(`
        CREATE TABLE IF NOT EXISTS SentMessages (
            id SERIAL NOT NULL,
            timestamp BIGINT NOT NULL DEFAULT 0,
            processed_by VARCHAR(255) NOT NULL,
            processed_by_color VARCHAR(8) NOT NULL,
            message TEXT,
            PRIMARY KEY (id)
        );
    `);


logger.debug(`Starting sender app on port ${APP_PORT}`);
app.listen(APP_PORT);