import si from 'systeminformation';
import os from 'os';

function getCpuLoad() {
    return new Promise((resolve) => {
        const start = os.cpus();
        setTimeout(() => {
            const end = os.cpus();
            let idle = 0;
            let total = 0;
            for (let i = 0; i < start.length; i++) {
                for (let type in start[i].times) {
                    total += end[i].times[type] - start[i].times[type];
                }
                idle += end[i].times.idle - start[i].times.idle;
            }
            resolve(100 - (100 * idle / total));
        }, 1000);
    });
}

async function test() {
    const mem = await si.mem();
    console.log("systeminformation mem.active / mem.total:", ((mem.active / mem.total) * 100).toFixed(1) + "%");
    console.log("systeminformation mem.used / mem.total:", ((mem.used / mem.total) * 100).toFixed(1) + "%");
    console.log("os.freemem / os.totalmem:", ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + "%");
    
    console.log("Measuring CPU...");
    const load1 = await getCpuLoad();
    console.log("os cpus load:", load1.toFixed(1) + "%");
    
    const cpu = await si.currentLoad();
    console.log("systeminformation currentLoad:", cpu.currentLoad.toFixed(1) + "%");
}

test();
