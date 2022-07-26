import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import xss from 'xss';
import log4js from 'log4js';

import express from 'express';
import session from 'express-session';
import pkg from 'pg';
import ampqlib from 'amqplib';
import redis from 'redis';
import connectRedis from 'connect-redis';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RedisStore = connectRedis(session);


const SERVICE_NAME = 'receiver';
const APP_PORT = 8080;

const {
    SESSION_SECRET,
    SESSIONSTORE,
    DBUSER,
    DBPASS,
    DATABASE,
    DBHOST,
    QUEUENAME,
    QUEUEURL,
    PROCESSING_TIME_MAX,
    RANDOM_ERROR_CHANCE
} = process.env;


const INSTANCE_COLORS = ['#6666ff','#66b266','#ffc966','#ff6666','#b266b2','#26acff','#31e8ee', '#c1e06c', '#f49c4c', '#f787ce'];

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
            url: `redis://${SESSIONSTORE}:6379`
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
const [{ messageConn, channel }, redisClient] = await Promise.all([rabbitConnect(), redisConnect()])


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

let processedCount = 0;
let lastProcessedAt = null;


////////////////////////////////////////////////////////////////
//                      MAIN CODE
////////////////////////////////////////////////////////////////


const getExistingMessages = async () => {
    const result = await pgPool.query("SELECT id, timestamp, time_taken, processed_by, processed_by_color, message FROM ProcessedMessages ORDER BY timestamp DESC LIMIT 20");
    return result?.rows;
};

const handleNewMessage = async (message, timeTaken) => {
    const randResult = Math.floor(Math.random() * RANDOM_ERROR_CHANCE);
    if (randResult === (RANDOM_ERROR_CHANCE - 1))
        throw new Error("*Random testing error!*");


    const now = new Date();

    const result = await pgPool.query(
        "INSERT INTO ProcessedMessages(timestamp, time_taken, processed_by, processed_by_color, message) VALUES ($1, $2, $3, $4, $5)",
        [now.getTime(), timeTaken, INSTANCE_NAME, INSTANCE_COLOR, message]);

    processedCount++;
    lastProcessedAt = now;
};

const buildHome = async (req, res) => {
    try {
        const rows = await getExistingMessages();
        const tableContents = generateRowsHtml(rows);
    
        const activeSessionCount = (await redisClient.v4.keys("sess:*"))?.length || 0; // this too is not particularly a great query to do in a real-world production environment!

        const fileContents = fs.readFileSync(__dirname + '/html/home.html', 'utf8');
        if (fileContents) {

            // since I decided to share this code publically: this would clearly result in multiple loops/string modifications 
            // and is not very optimal, not easy to understand. In the real world I might've replaced this with something like pug.js
            // or similar. But for this experiment project I figured this is ok

            res.send(fileContents.replace('${PLACEHOLDER}', tableContents)
                .replace('${FOR_NODE}', processedCount)
                .replace('${FOR_NODE_LAST}', lastProcessedAt ? lastProcessedAt.toUTCString() : 'Never')
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
            <th scope="col">Received At</th>
            <th scope="col">Processed in MS</th>
            <th scope="col">Submission</th>
        </tr>
        </thead>`; // and this too is not the best way to build templates: a templating lib would've been preferable in the real world!


    if (!rows || !rows.length) {
        result += `</table> <p>No messages processed yet</p>`
        return result;
    }

    result += '<tbody>';

    rows.forEach(row => {
        result += `<tr>
            <th scope="row">${row.id}</th>
            <td><span class="badge rounded-pill" style="background-color: ${row.processed_by_color} !important;">${row.processed_by}</span></td>
            <td>${new Date(parseInt(row.timestamp)).toUTCString()}</td>
            <td>${parseInt(row.time_taken)} ms</td>
            <td>${xss(row.message)}</td>
        </tr>
        `;
    });

    result += '</tbody></table>';

    return result;
};

app.get('/received', (req, res) => {
    buildHome(req, res);
});


channel.consume(QUEUENAME, (msg) => {
    const processingTimeMS = Math.floor(Math.random() * PROCESSING_TIME_MAX);
    const start = new Date().getTime();
    const content = msg.content.toString();

    logger.debug("Received queue task for message '%s'. Assigned processing time %d ms...", content, processingTimeMS);

    setTimeout(() => {
        handleNewMessage(content, processingTimeMS)
        .then(() => {
            const elapsed = new Date().getTime() - start;
            logger.debug("Message processing complete for '%s' (%d ms elapsed)", content, elapsed);
            channel.ack(msg);
        })
        .catch((e) => {
            logger.error("Failed to handle new message due to error %s", e.message);
            channel.reject(msg);
        });

    }, processingTimeMS);

}, { noAck: false });



// initiating db
logger.debug(`Initiating receiver DB...`);
pgPool.query(`
CREATE TABLE IF NOT EXISTS ProcessedMessages (
    id SERIAL NOT NULL,
    timestamp BIGINT NOT NULL DEFAULT 0,
    time_taken BIGINT NOT NULL DEFAULT 0,
    processed_by VARCHAR(255) NOT NULL,
    processed_by_color VARCHAR(8) NOT NULL,
    message TEXT,
    PRIMARY KEY (id)
);
`);

logger.debug(`Starting receiver app on port ${APP_PORT}`);
app.listen(APP_PORT);