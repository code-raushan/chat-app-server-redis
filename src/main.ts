import fastifyCors from '@fastify/cors';
import { channel } from 'diagnostics_channel';
import dotenv from 'dotenv';
import fastify from 'fastify';
import fastifyIO from 'fastify-socket.io'
import closeWithGrace from 'close-with-grace';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5555', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT;

const CONNECTION_COUNT_KEY="chat:connection-count";
const CONNECTION_COUNT_UPDATED_CHANNEL = 'chat:connection-count-updated';


import { Redis } from 'ioredis';

if(!REDIS_ENDPOINT){
    console.error('Missing REDIS URL ENDPOINT');
    process.exit(1);
};

const publisher = new Redis(REDIS_ENDPOINT);
const subscriber = new Redis(REDIS_ENDPOINT);

let connectedClients = 0;

async function buildServer(){
    const app = fastify();

    /*Registering CORS policy */
    await app.register(fastifyCors, {
        origin: CORS_ORIGIN
    }); 

    /* Registering Socket */
    await app.register(fastifyIO);
    
    const connCount = await publisher.get(CONNECTION_COUNT_KEY);

    if(!connCount){
        await publisher.set(CONNECTION_COUNT_KEY, 0);
    }

    app.io.on('connection', async (io)=>{
        console.log('Client Connected');
        // incrementing the connection count by 1 on each new connection
        const incrResult = await publisher.incr(CONNECTION_COUNT_KEY);

        connectedClients++;

        await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(incrResult));

        io.on('disconnect', async (io)=>{
            connectedClients--;
            console.log('Client Disconnected');
            const decrResult = await publisher.decr(CONNECTION_COUNT_KEY);
            await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(decrResult));
        });
    });

    subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (err, count)=>{
        if(err){
            console.error(`Error subscribing to ${CONNECTION_COUNT_UPDATED_CHANNEL}`);
            return;
        };
        console.log(`${count} clients connected to ${CONNECTION_COUNT_UPDATED_CHANNEL}`)
    }); 

    subscriber.on('message', (channel, message)=>{
        console.log(`Recieved ${message} from ${channel}`)
    });

    app.get('/healthcheck', ()=>{
        return {
            status: "ok",
            port: PORT
        }
    });

    return app;
};

async function main(){
    const app = await buildServer();
    try {
        await app.listen({
            port: PORT,
            host: HOST
        });
        
        closeWithGrace({delay: 2000}, async({signal, err})=>{
            if(connectedClients>0){
                const currentCount = parseInt((await publisher.get(CONNECTION_COUNT_KEY))||"0", 10);
                const newCount = Math.max(currentCount - connectedClients, 0);
                await publisher.set(CONNECTION_COUNT_KEY, newCount);
            }
            await app.close();
        })


        console.log(`Server started at http://${HOST}:${PORT}`);
    } catch (error) {
        console.error(error);
        process.exit(1)
    }
}
main();