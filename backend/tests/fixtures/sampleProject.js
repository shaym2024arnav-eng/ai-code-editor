// A small full-stack project that exercises every analyzer feature.
const files = {
  "backend/server.js": `
const express = require("express");
const userRoutes = require("./routes/userRoutes");
const app = express();
app.use(express.json());
app.use("/api/users", userRoutes);
app.get("/health", (req, res) => res.json({ ok: true }));
module.exports = app;
`,
  "backend/routes/userRoutes.js": `
const express = require("express");
const router = express.Router();
const { getUsers, createUser } = require("../controllers/userController");
const protect = require("../middleware/auth");
router.get("/", getUsers);
router.post("/", protect, createUser);
router.delete("/:id", protect, async (req, res) => {
  res.status(204).end();
});
module.exports = router;
`,
  "backend/controllers/userController.js": `
const User = require("../models/User");
const { formatUser } = require("../utils/format");

exports.getUsers = async (req, res) => {
  const users = await User.find();
  res.json(users.map(formatUser));
};

exports.createUser = async (req, res) => {
  const user = await User.create(req.body);
  res.status(201).json(formatUser(user));
};
`,
  "backend/middleware/auth.js": `
const protect = (req, res, next) => next();
module.exports = protect;
`,
  "backend/models/User.js": `
const mongoose = require("mongoose");
const userSchema = new mongoose.Schema({ name: String });
module.exports = mongoose.model("User", userSchema);
`,
  "backend/utils/format.js": `
function formatUser(u) { return { id: u._id, name: u.name }; }
function unusedHelper() { return 1; }
module.exports = { formatUser, unusedHelper };
`,
  "backend/utils/broken.js": `
const helper = require("../Utils/format");
module.exports = helper;
`,
  "frontend/src/main.jsx": `
import { createRoot } from "react-dom/client";
import App from "./App";
createRoot(document.getElementById("root")).render(<App />);
`,
  "frontend/src/App.jsx": `
import { useEffect, useState } from "react";
import UserList from "@/components/UserList";
import { fetchUsers, addUser } from "./api";
export default function App() {
  const [users, setUsers] = useState([]);
  useEffect(() => { fetchUsers().then(setUsers); }, []);
  return <UserList users={users} onAdd={(n) => addUser(n)} />;
}
`,
  "frontend/src/api/index.js": `
export * from "./users";
`,
  "frontend/src/api/users.js": `
import axios from "axios";
import { API_URL } from "../config";
export const fetchUsers = () => axios.get(\`\${API_URL}/users\`).then((r) => r.data);
export const addUser = (name) => fetch(API_URL + "/users", { method: "POST", body: JSON.stringify({ name }) });
export const removeUser = (id) => axios.delete(\`\${API_URL}/users/\${id}\`);
export const ping = () => fetch("https://example.org/ping");
`,
  "frontend/src/config.js": `
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
`,
  "frontend/src/components/UserList.jsx": `
import { a } from "./cycleA";
export default function UserList({ users }) {
  return <ul>{users.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
}
`,
  "frontend/src/components/cycleA.js": `
import { b } from "./cycleB";
export const a = () => b();
`,
  "frontend/src/components/cycleB.js": `
import { a } from "./cycleA";
export const b = () => 1;
export const c = () => a();
`,
  "README.md": "# Sample\\n",
};

const sampleFiles = () => Object.entries(files).map(([path, content]) => ({ path, content: content.trimStart() }));

module.exports = { sampleFiles };
