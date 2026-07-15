import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        payment: resolve(__dirname, 'payment.html'),
        billPayment: resolve(__dirname, 'bill-payment.html'),
        bookings: resolve(__dirname, 'bookings.html'),
        bookingsPay: resolve(__dirname, 'bookings-pay.html'),
      },
    },
  },
});
