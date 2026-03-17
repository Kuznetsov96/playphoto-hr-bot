import { createCanvas, registerFont } from 'canvas';
import type { DailyStatus } from './dashboard-service.js';

export class ReportImageGenerator {
    private readonly width = 600;
    private readonly rowHeight = 60;
    private readonly padding = 40;
    private readonly borderRadius = 15;

    async generateStatusImage(status: DailyStatus): Promise<Buffer> {
        const itemCount = status.balances.length;
        const height = (this.rowHeight * (itemCount + 2)) + (this.padding * 2) + 20;

        const canvas = createCanvas(this.width, height);
        const ctx = canvas.getContext('2d');

        // --- Background ---
        ctx.fillStyle = '#121212';
        ctx.fillRect(0, 0, this.width, height);

        // --- Header ---
        ctx.fillStyle = '#1e1e1e';
        this.roundRect(ctx, 20, 20, this.width - 40, 80, this.borderRadius);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px sans-serif';
        ctx.fillText(`STATUS: ${status.date}`, 50, 70);

        // --- Balances Table Body ---
        const tableY = 120;
        ctx.fillStyle = '#1e1e1e';
        this.roundRect(ctx, 20, tableY, this.width - 40, (this.rowHeight * (itemCount + 1)) + 20, this.borderRadius);
        ctx.fill();

        let currentY = tableY + 40;
        let total = 0;

        status.balances.forEach((b, index) => {
            const name = (b.name || 'Unknown').split(' ')[0];
            const balance = Math.round(b.balance || 0);
            total += balance;

            // Row background for zebra effect
            if (index % 2 === 0) {
                ctx.fillStyle = '#252525';
                this.roundRect(ctx, 30, currentY - 30, this.width - 60, this.rowHeight, 8);
                ctx.fill();
            }

            ctx.fillStyle = '#e0e0e0';
            ctx.font = '22px sans-serif';
            ctx.fillText(name as string, 50, currentY + 10);

            if (b.error) {
                ctx.fillStyle = '#ff5252';
                ctx.fillText('ERROR', this.width - 150, currentY + 10);
            } else {
                ctx.fillStyle = '#4caf50';
                ctx.font = 'bold 22px sans-serif';
                const balStr = balance.toLocaleString('en-US').replace(/,/g, ' ') + ' UAH';
                const metrics = ctx.measureText(balStr);
                ctx.fillText(balStr, this.width - metrics.width - 50, currentY + 10);
            }

            currentY += this.rowHeight;
        });

        // --- Total ---
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 26px sans-serif';
        ctx.fillText('TOTAL', 50, currentY + 20);

        const totalStr = Math.round(total).toLocaleString('en-US').replace(/,/g, ' ') + ' UAH';
        const totalMetrics = ctx.measureText(totalStr);
        ctx.fillText(totalStr, this.width - totalMetrics.width - 50, currentY + 20);

        return canvas.toBuffer('image/png');
    }

    private roundRect(ctx: any, x: number, y: number, width: number, height: number, radius: number) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }
}

export const reportImageGenerator = new ReportImageGenerator();
