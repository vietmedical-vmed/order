/** @type {import('tailwindcss').Config} */
// 4.1: bảng màu ngữ nghĩa — trước đây config remap đè `emerald`/`blue`/`sky` về cùng dải xanh
// dương nên class tên "emerald" lại ra màu xanh dương (rất khó bảo trì). Nay mỗi vai trò có
// đúng 1 tên: primary (xanh thương hiệu), danger (đỏ), warning (hổ phách), slate (nền/chữ).
// Đổi nhận diện sau này chỉ cần sửa các dải màu ở đây.
module.exports = {
  content: ['./index.html', './js/**/*.js'],
  theme: {
    extend: {
      colors: {
        // Nền & chữ trung tính
        slate: { 50: '#f0f2f5', 100: '#e4e6eb', 200: '#dadde1', 300: '#ccd0d5', 400: '#8a8d91', 500: '#65676b', 600: '#4b4f56', 700: '#3a3b3c', 800: '#242526', 900: '#18191a' },
        // Màu chính (nút, link, số liệu nhấn)
        primary: { 50: '#e7f3ff', 100: '#cfe4ff', 200: '#a8c8ff', 300: '#7aa7fb', 400: '#4a90f2', 500: '#1877f2', 600: '#166fe5', 700: '#0c5dc7', 800: '#0a4fa8', 900: '#0a3a7a' },
        // Lỗi / nguy hiểm / xoá
        danger: { 50: '#fdecee', 100: '#fad3d6', 200: '#f5aab0', 300: '#ef7d85', 400: '#f9525c', 500: '#fa383e', 600: '#e41e3f', 700: '#c81f3d', 800: '#9f1830', 900: '#7a1225' },
        // Chờ xử lý / cần chú ý (giữ nguyên dải amber mặc định của Tailwind)
        warning: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f' },
      },
    },
  },
  plugins: [],
};
