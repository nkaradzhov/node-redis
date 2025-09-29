class ClientCounter {
  #id = 0;
  #activeClients: number[] = [];

  getNextId(): number {
    this.#activeClients.push(this.#id);
    return this.#id++;
  }

  getActiveClients() {
    return { total: this.#activeClients.length, clients: this.#activeClients };
  }

  removeClient(id: number) {
    this.#activeClients = this.#activeClients.filter((cid) => cid !== id);
  }
}

export default new ClientCounter();
