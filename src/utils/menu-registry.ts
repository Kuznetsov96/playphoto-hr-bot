import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../types/context.js";

/**
 * Global registry for menus to avoid circular dependencies.
 */
class MenuRegistry {
    private menus: Map<string, Menu<MyContext>> = new Map();

    register(menu: Menu<MyContext>) {
        // Use any to access protected 'id' property
        const menuId = (menu as any).id;
        if (!menuId) {
            throw new Error("Menu must have an ID to be registered.");
        }
        this.menus.set(menuId, menu);
    }

    get(id: string): Menu<MyContext> | undefined {
        return this.menus.get(id);
    }
}

export const menuRegistry = new MenuRegistry();
